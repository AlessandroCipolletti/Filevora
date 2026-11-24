import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from '../errors/error.js';
import { assetObjectKey, createId, nowIso, sha256 } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import {
  frameOffsetMs,
  spriteTimeline,
  thumbnailTimes,
} from '../processors/frames.js';
import { probeMedia, runFfmpeg } from '../processors/ffmpeg.js';
import { recordProcessingProgress } from '../queue/processing-queue.js';
import type { ExifMode } from '../safety/exif.js';
import { materialize } from '../storage/stage.js';
import type { StorageDriver } from '../types/index.js';
import type { NamedPreset, PresetOutput } from './catalog.js';

interface PresetFile {
  id: string;
  tenant_id: string;
  original_object_key: string | null;
}

/** Write one preset's versions next to the original. The original stays. */
export async function publishNamedPreset(input: {
  sql: Sql;
  storage: StorageDriver;
  file: PresetFile;
  preset: NamedPreset;
  exif: ExifMode;
  ffmpeg: string;
  ffprobe: string;
  timeoutMs: number;
  jobId: string;
  maxPixels: number;
  maxHeight: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!input.file.original_object_key) throw fail('NOT_FOUND');
  const local = await materialize(
    input.storage,
    input.file.original_object_key,
  );
  const staged = { ...input, source: local.path };
  const names: string[] = [];
  const started = Date.now();
  const total = Math.max(1, input.preset.outputs.length);
  try {
    for (let index = 0; index < input.preset.outputs.length; index += 1) {
      const output = staged.preset.outputs[index];
      if (!output) continue;
      const family = staged.preset.families[0];
      const written =
        family === 'video' && hasPoster(output)
          ? await publishPoster(staged, output)
          : family === 'video' && hasThumbnails(output)
            ? await publishThumbnails(staged, output)
            : family === 'video' && hasSprite(output)
              ? await publishSprite(staged, output)
              : family === 'video'
                ? await publishVideo(staged, output)
                : await publishImage(staged, output);
      names.push(...written);
      await recordProcessingProgress(
        staged.file.id,
        (index + 1) / total,
        started,
      );
    }
    await staged.sql.run(
      `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
      [nowIso(), staged.file.id],
    );
    return names;
  } finally {
    await local.cleanup();
  }
}

async function publishImage(
  input: {
    sql: Sql;
    storage: StorageDriver;
    source: string;
    file: PresetFile;
    preset: NamedPreset;
    exif: ExifMode;
    maxPixels: number;
  },
  output: PresetOutput,
): Promise<string[]> {
  if (await alreadyStored(input, output.version)) return [output.version];
  const source = input.source;
  const sharp = (await import('sharp')).default;
  let pipeline = sharp(source, { limitInputPixels: input.maxPixels }).rotate();
  for (const operation of output.operations) {
    if (operation.op === 'image.crop') {
      pipeline = pipeline.extract({
        left: operation.x,
        top: operation.y,
        width: operation.width,
        height: operation.height,
      });
    } else if (operation.op === 'image.resize') {
      const cover = operation.fit === 'cover' || operation.fit === 'fill';
      pipeline = pipeline.resize({
        width: operation.width,
        ...(operation.height ? { height: operation.height } : {}),
        fit: operation.fit ?? 'contain',
        withoutEnlargement: !cover,
      });
    }
  }
  if (input.exif === 'none') pipeline = pipeline.withMetadata();
  const body = await pipeline.webp({ quality: 80 }).toBuffer();
  const info = await sharp(body).metadata();
  await insertVariant(input, {
    version: output.version,
    body,
    mime: 'image/webp',
    extension: 'webp',
    width: info.width,
    height: info.height,
  });
  return [output.version];
}

async function publishVideo(
  input: {
    sql: Sql;
    storage: StorageDriver;
    source: string;
    file: PresetFile;
    preset: NamedPreset;
    ffmpeg: string;
    ffprobe: string;
    timeoutMs: number;
    jobId: string;
    maxHeight: number;
    signal?: AbortSignal;
  },
  output: PresetOutput,
): Promise<string[]> {
  if (await alreadyStored(input, output.version)) return [output.version];
  const resize = output.operations.find(
    (operation) => operation.op === 'video.resize',
  );
  if (
    resize &&
    resize.op === 'video.resize' &&
    resize.height > input.maxHeight
  ) {
    throw fail('INVALID_RECIPE', {
      message: `Preset ${input.preset.name} asks for ${resize.height}px and the maximum video height is ${input.maxHeight}.`,
    });
  }
  const source = input.source;
  const probe = await probeMedia(input.ffprobe, source, input.timeoutMs);
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-preset-'));
  const target = path.join(work, `${output.version}.mp4`);
  try {
    const filters: string[] = [];
    let start: number | undefined;
    let end: number | undefined;
    for (const operation of output.operations) {
      if (operation.op === 'video.crop') {
        filters.push(
          `crop=${operation.width}:${operation.height}:${operation.x}:${operation.y}`,
        );
      } else if (operation.op === 'video.resize') {
        filters.push(
          operation.width
            ? `scale=${operation.width}:${operation.height}`
            : `scale=-2:${operation.height}`,
        );
      } else if (operation.op === 'video.trim') {
        start = operation.startMs / 1000;
        const cap =
          probe.durationMs > 0
            ? Math.min(operation.endMs, probe.durationMs)
            : operation.endMs;
        end = cap / 1000;
      }
    }
    const args = ['-y', '-i', source];
    if (start !== undefined) args.push('-ss', String(start));
    if (end !== undefined) args.push('-to', String(end));
    if (filters.length > 0) args.push('-vf', filters.join(','));
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      target,
    );
    await runFfmpeg(input.ffmpeg, args, {
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      durationMs: probe.durationMs,
    });
    const body = readFileSync(target);
    const probed = await probeMedia(input.ffprobe, target, input.timeoutMs);
    await insertVariant(input, {
      version: output.version,
      body,
      mime: 'video/mp4',
      extension: 'mp4',
      width: probed.width,
      height: probed.height,
      durationMs: probed.durationMs,
    });
    return [output.version];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function publishPoster(
  input: FrameInput,
  output: PresetOutput,
): Promise<string[]> {
  if (await alreadyStored(input, output.version)) return [output.version];
  const poster = output.operations.find(
    (operation) => operation.op === 'video.poster',
  );
  const width =
    poster && poster.op === 'video.poster' ? (poster.width ?? 1280) : 1280;
  const probe = await probeMedia(input.ffprobe, input.source, input.timeoutMs);
  const atMs = frameOffsetMs({
    durationMs: probe.durationMs,
    ...(poster && poster.op === 'video.poster' && poster.atMs !== undefined
      ? { atMs: poster.atMs }
      : {}),
    ...(poster && poster.op === 'video.poster' && poster.atPercent !== undefined
      ? { atPercent: poster.atPercent }
      : {}),
  });
  const body = await stillWebp(input, atMs, width);
  const info = await (await import('sharp')).default(body).metadata();
  await insertVariant(input, {
    version: output.version,
    body,
    mime: 'image/webp',
    extension: 'webp',
    width: info.width,
    height: info.height,
  });
  return [output.version];
}

async function publishThumbnails(
  input: FrameInput,
  output: PresetOutput,
): Promise<string[]> {
  const spec = output.operations.find(
    (operation) => operation.op === 'video.thumbnails',
  );
  const width =
    spec && spec.op === 'video.thumbnails' ? (spec.width ?? 320) : 320;
  const probe = await probeMedia(input.ffprobe, input.source, input.timeoutMs);
  const times = thumbnailTimes({
    durationMs: probe.durationMs,
    ...(spec && spec.op === 'video.thumbnails' && spec.count !== undefined
      ? { count: spec.count }
      : {}),
    ...(spec && spec.op === 'video.thumbnails' && spec.intervalMs !== undefined
      ? { intervalMs: spec.intervalMs }
      : {}),
    ...(spec && spec.op === 'video.thumbnails' && spec.atMs
      ? { atMs: spec.atMs }
      : {}),
    ...(spec && spec.op === 'video.thumbnails' && spec.atPercent
      ? { atPercent: spec.atPercent }
      : {}),
  });
  const names = times.map((_, index) => `${output.version}-${index + 1}`);
  const first = names[0];
  if (!first || (await alreadyStored(input, first))) return names;
  for (let index = 0; index < times.length; index += 1) {
    const atMs = times[index] ?? 0;
    const version = names[index];
    if (!version) continue;
    const body = await stillWebp(input, atMs, width);
    const info = await (await import('sharp')).default(body).metadata();
    await insertVariant(input, {
      version,
      body,
      mime: 'image/webp',
      extension: 'webp',
      width: info.width,
      height: info.height,
    });
  }
  return names;
}

async function publishSprite(
  input: FrameInput,
  output: PresetOutput,
): Promise<string[]> {
  const spec = output.operations.find(
    (operation) => operation.op === 'video.sprite',
  );
  const columns = spec && spec.op === 'video.sprite' ? spec.columns : 1;
  const rows = spec && spec.op === 'video.sprite' ? spec.rows : 1;
  const cellWidth =
    spec && spec.op === 'video.sprite' ? (spec.cellWidth ?? 160) : 160;
  const names = [
    output.version,
    `${output.version}-vtt`,
    `${output.version}-json`,
  ];
  if (await alreadyStored(input, output.version)) return names;
  const probe = await probeMedia(input.ffprobe, input.source, input.timeoutMs);
  const times = thumbnailTimes({
    durationMs: probe.durationMs,
    count: columns * rows,
    ...(spec && spec.op === 'video.sprite' && spec.intervalMs !== undefined
      ? { intervalMs: spec.intervalMs }
      : {}),
  });
  const pngs: Buffer[] = [];
  for (const atMs of times) pngs.push(await stillPng(input, atMs));
  const sharp = (await import('sharp')).default;
  const fitted: Buffer[] = [];
  let cellHeight = cellWidth;
  for (const png of pngs) {
    const resized = await sharp(png)
      .resize({
        width: cellWidth,
        ...(fitted.length > 0
          ? { height: cellHeight, fit: 'fill' as const }
          : {}),
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
    if (fitted.length === 0) {
      cellHeight = (await sharp(resized).metadata()).height ?? cellWidth;
    }
    fitted.push(resized);
  }
  const sheet = await sharp({
    create: {
      width: cellWidth * columns,
      height: cellHeight * Math.max(1, Math.ceil(fitted.length / columns)),
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(
      fitted.map((inputFrame, index) => ({
        input: inputFrame,
        left: (index % columns) * cellWidth,
        top: Math.floor(index / columns) * cellHeight,
      })),
    )
    .webp({ quality: 80 })
    .toBuffer();
  const imageName = `${output.version}.webp`;
  const map = spriteTimeline({
    timesMs: times,
    columns,
    cellWidth,
    cellHeight,
    image: imageName,
  });
  const info = await sharp(sheet).metadata();
  await insertVariant(input, {
    version: output.version,
    body: sheet,
    mime: 'image/webp',
    extension: 'webp',
    width: info.width,
    height: info.height,
  });
  await insertVariant(input, {
    version: `${output.version}-vtt`,
    body: Buffer.from(map.vtt),
    mime: 'text/vtt',
    extension: 'vtt',
  });
  await insertVariant(input, {
    version: `${output.version}-json`,
    body: Buffer.from(map.json),
    mime: 'application/json',
    extension: 'json',
  });
  return names;
}

interface FrameInput {
  sql: Sql;
  storage: StorageDriver;
  source: string;
  file: PresetFile;
  preset: NamedPreset;
  exif: ExifMode;
  ffmpeg: string;
  ffprobe: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

async function stillPng(input: FrameInput, atMs: number): Promise<Buffer> {
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-still-'));
  try {
    const file = path.join(work, 'frame.png');
    const args = (offsetMs: number) => [
      '-y',
      '-ss',
      String(offsetMs / 1000),
      '-i',
      input.source,
      '-frames:v',
      '1',
      file,
    ];
    const options = {
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    };
    try {
      await runFfmpeg(input.ffmpeg, args(atMs), options);
    } catch (error) {
      if (atMs === 0) throw error;
      await runFfmpeg(input.ffmpeg, args(0), options);
    }
    return readFileSync(file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function stillWebp(
  input: FrameInput,
  atMs: number,
  width: number,
): Promise<Buffer> {
  const png = await stillPng(input, atMs);
  const sharp = (await import('sharp')).default;
  let pipeline = sharp(png)
    .rotate()
    .resize({ width, withoutEnlargement: true });
  if (input.exif === 'none') pipeline = pipeline.withMetadata();
  return pipeline.webp({ quality: 80 }).toBuffer();
}

function hasPoster(output: PresetOutput): boolean {
  return output.operations.some((operation) => operation.op === 'video.poster');
}

function hasThumbnails(output: PresetOutput): boolean {
  return output.operations.some(
    (operation) => operation.op === 'video.thumbnails',
  );
}

function hasSprite(output: PresetOutput): boolean {
  return output.operations.some((operation) => operation.op === 'video.sprite');
}

async function alreadyStored(
  input: { sql: Sql; file: PresetFile; preset: NamedPreset },
  version: string,
): Promise<boolean> {
  const existing = await input.sql.get<{ id: string }>(
    `SELECT id FROM variants WHERE file_id = ? AND name = ? AND recipe_id = ? AND recipe_version = ?`,
    [input.file.id, version, input.preset.name, 1],
  );
  return Boolean(existing);
}

async function insertVariant(
  input: {
    sql: Sql;
    storage: StorageDriver;
    file: PresetFile;
    preset: NamedPreset;
  },
  variant: {
    version: string;
    body: Buffer;
    mime: string;
    extension: string;
    width?: number;
    height?: number;
    durationMs?: number;
  },
): Promise<void> {
  const key = assetObjectKey(
    input.file.tenant_id,
    input.file.id,
    variant.version,
    variant.extension,
  );
  await input.storage.putObject({
    key,
    body: variant.body,
    contentType: variant.mime,
  });
  await input.sql.run(
    `INSERT INTO variants (
      id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, width, height,
      duration_ms, checksum, status, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
    [
      createId('variant'),
      input.file.id,
      variant.version,
      input.preset.name,
      key,
      variant.mime,
      variant.body.byteLength,
      variant.width ?? null,
      variant.height ?? null,
      variant.durationMs ?? null,
      sha256(variant.body),
      nowIso(),
    ],
  );
}
