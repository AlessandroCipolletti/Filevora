import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from '../errors/error.js';
import { assetObjectKey, createId, nowIso, sha256 } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { probeMedia, runFfmpeg } from '../processors/ffmpeg.js';
import { recordProcessingProgress } from '../queue/processing-queue.js';
import type { ExifMode } from '../safety/exif.js';
import { writeBytes } from '../storage/filesystem.js';
import type { NamedPreset, PresetOutput } from './catalog.js';

interface PresetFile {
  id: string;
  tenant_id: string;
  original_object_key: string | null;
}

/** Write one preset's versions next to the original. The original stays. */
export async function publishNamedPreset(input: {
  sql: Sql;
  root: string;
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
  const names: string[] = [];
  const started = Date.now();
  const total = Math.max(1, input.preset.outputs.length);
  for (let index = 0; index < input.preset.outputs.length; index += 1) {
    const output = input.preset.outputs[index];
    if (!output) continue;
    const family = input.preset.families[0];
    if (family === 'video' && hasPoster(output)) {
      await publishPoster(input, output);
    } else if (family === 'video') {
      await publishVideo(input, output);
    } else {
      await publishImage(input, output);
    }
    names.push(output.version);
    await recordProcessingProgress(input.file.id, (index + 1) / total, started);
  }
  await input.sql.run(
    `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
    [nowIso(), input.file.id],
  );
  return names;
}

async function publishImage(
  input: {
    sql: Sql;
    root: string;
    file: PresetFile;
    preset: NamedPreset;
    exif: ExifMode;
    maxPixels: number;
  },
  output: PresetOutput,
): Promise<void> {
  if (await alreadyStored(input, output.version)) return;
  const source = path.join(input.root, input.file.original_object_key ?? '');
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
}

async function publishVideo(
  input: {
    sql: Sql;
    root: string;
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
): Promise<void> {
  if (await alreadyStored(input, output.version)) return;
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
  const source = path.join(input.root, input.file.original_object_key ?? '');
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function publishPoster(
  input: {
    sql: Sql;
    root: string;
    file: PresetFile;
    preset: NamedPreset;
    exif: ExifMode;
    ffmpeg: string;
    timeoutMs: number;
    jobId: string;
    signal?: AbortSignal;
  },
  output: PresetOutput,
): Promise<void> {
  if (await alreadyStored(input, output.version)) return;
  const poster = output.operations.find(
    (operation) => operation.op === 'video.poster',
  );
  const atMs = poster && poster.op === 'video.poster' ? (poster.atMs ?? 0) : 0;
  const width =
    poster && poster.op === 'video.poster' ? (poster.width ?? 1280) : 1280;
  const source = path.join(input.root, input.file.original_object_key ?? '');
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-poster-'));
  try {
    const sharp = (await import('sharp')).default;
    const file = path.join(work, 'poster.png');
    await runFfmpeg(
      input.ffmpeg,
      ['-y', '-ss', String(atMs / 1000), '-i', source, '-frames:v', '1', file],
      { timeoutMs: input.timeoutMs, signal: input.signal },
    );
    let pipeline = sharp(file)
      .rotate()
      .resize({ width, withoutEnlargement: true });
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function hasPoster(output: PresetOutput): boolean {
  return output.operations.some((operation) => operation.op === 'video.poster');
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
  input: { sql: Sql; root: string; file: PresetFile; preset: NamedPreset },
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
  await writeBytes(input.root, key, variant.body);
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
