import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { fail } from '../errors/error.js';
import { assetObjectKey, extensionForMime, nowIso, sha256 } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { probeMedia, runFfmpeg } from '../processors/ffmpeg.js';
import {
  recordProcessingProgress,
  recordRunnerPid,
} from '../queue/processing-queue.js';
import { writeBytes } from '../storage/filesystem.js';
import type { ExifMode } from '../safety/exif.js';
import type { MalwareScanner } from '../safety/scan.js';
import type { AssetTransformOperation } from './schema.js';

export async function measureOriginal(
  root: string,
  key: string,
  mime: string,
  ffprobe: string,
): Promise<{
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
}> {
  const absolute = path.join(root, key);
  if (mime.startsWith('image/')) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(absolute).metadata();
    return {
      ...(meta.width ? { width: meta.width } : {}),
      ...(meta.height ? { height: meta.height } : {}),
    };
  }
  if (mime.startsWith('video/')) {
    const probe = await probeMedia(ffprobe, absolute, 15_000);
    return {
      ...(probe.width ? { width: probe.width } : {}),
      ...(probe.height ? { height: probe.height } : {}),
      durationMs: probe.durationMs,
    };
  }
  if (mime === 'application/pdf') {
    const doc = await PDFDocument.load(readFileSync(absolute));
    return { pageCount: doc.getPageCount() };
  }
  return {};
}

export async function applyAssetTransform(input: {
  sql: Sql;
  root: string;
  ffmpeg: string;
  ffprobe: string;
  timeoutMs: number;
  jobId: string;
  sourceId: string;
  targetId: string;
  tenantId: string;
  mime: string;
  sourceKey: string;
  operations: AssetTransformOperation[];
  exif?: ExifMode;
  scanner?: MalwareScanner;
}): Promise<void> {
  const sourcePath = path.join(input.root, input.sourceKey);
  const startedAt = Date.now();
  let body: Buffer;
  let outMime = input.mime;
  if (input.mime.startsWith('image/')) {
    body = await applyImage(sourcePath, input.operations, input.exif ?? 'gps');
    outMime = input.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    await recordProcessingProgress(input.targetId, 1, startedAt);
  } else if (input.mime.startsWith('video/')) {
    body = await applyVideo(sourcePath, input, startedAt);
    outMime = 'video/mp4';
  } else if (input.mime === 'application/pdf') {
    body = await applyPdf(sourcePath, input.operations);
    await recordProcessingProgress(input.targetId, 1, startedAt);
  } else {
    throw fail('TRANSFORM_REJECTED', {
      message: `No transform is valid for ${input.mime}.`,
      context: { detectedType: input.mime },
    });
  }
  const key = assetObjectKey(
    input.tenantId,
    input.targetId,
    'original',
    extensionForMime(outMime),
  );
  await writeBytes(input.root, key, body);
  if (input.scanner) {
    const verdict = await input.scanner.scan({
      assetId: input.targetId,
      mime: outMime,
      path: path.join(input.root, key),
      bytes: body,
    });
    if (verdict === 'infected') {
      const { rm } = await import('node:fs/promises');
      await rm(path.join(input.root, key), { force: true });
      throw fail('MALWARE_DETECTED');
    }
  }
  if (input.sourceId === input.targetId && input.sourceKey !== key) {
    const { rm } = await import('node:fs/promises');
    await rm(path.join(input.root, input.sourceKey), { force: true });
  }
  if (input.sourceId === input.targetId) {
    await deleteSiblingVariants(input.root, input.tenantId, input.targetId);
    await input.sql.run(
      `UPDATE variants SET status = 'deleted' WHERE file_id = ?`,
      [input.targetId],
    );
  }
  const now = nowIso();
  await input.sql.run(
    `UPDATE files SET detected_mime = ?, declared_mime = ?, bytes = ?, checksum = ?,
      original_object_key = ?, upload_state = 'verified', processing_state = 'ready', updated_at = ?
     WHERE id = ?`,
    [outMime, outMime, body.byteLength, sha256(body), key, now, input.targetId],
  );
}

async function applyImage(
  source: string,
  operations: AssetTransformOperation[],
  exif: ExifMode,
): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  let pipeline = sharp(source).rotate();
  for (const operation of operations) {
    if (operation.op === 'image.crop') {
      pipeline = pipeline.extract({
        left: operation.x,
        top: operation.y,
        width: operation.width,
        height: operation.height,
      });
    } else if (operation.op === 'image.resize') {
      pipeline = pipeline.resize({
        width: operation.width,
        ...(operation.height ? { height: operation.height } : {}),
        fit: operation.fit ?? 'cover',
      });
    }
  }
  if (exif === 'none') pipeline = pipeline.withMetadata();
  const meta = await sharp(source).metadata();
  if (meta.format === 'jpeg') return pipeline.jpeg({ quality: 90 }).toBuffer();
  return pipeline.png().toBuffer();
}

async function applyVideo(
  source: string,
  input: {
    ffmpeg: string;
    timeoutMs: number;
    jobId: string;
    targetId: string;
    operations: AssetTransformOperation[];
  },
  startedAt: number,
): Promise<Buffer> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-transform-'));
  const output = path.join(work, 'out.mp4');
  const filters: string[] = [];
  let start: number | undefined;
  let end: number | undefined;
  for (const operation of input.operations) {
    if (operation.op === 'video.crop') {
      filters.push(
        `crop=${operation.width}:${operation.height}:${operation.x}:${operation.y}`,
      );
    } else if (operation.op === 'video.resize') {
      filters.push(`scale=${operation.width}:${operation.height}`);
    } else if (operation.op === 'video.trim') {
      start = operation.startMs / 1000;
      end = operation.endMs / 1000;
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
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-progress',
    'pipe:1',
    output,
  );
  try {
    await runFfmpeg(input.ffmpeg, args, {
      timeoutMs: input.timeoutMs,
      durationMs: end && start !== undefined ? (end - start) * 1000 : undefined,
      onPid: (pid) => {
        void recordRunnerPid(input.jobId, pid);
      },
      onProgress: (ratio) => {
        void recordProcessingProgress(input.targetId, ratio, startedAt);
      },
    });
    return readFile(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function applyPdf(
  source: string,
  operations: AssetTransformOperation[],
): Promise<Buffer> {
  const doc = await PDFDocument.load(readFile(source));
  const remove = new Set<number>();
  for (const operation of operations) {
    if (operation.op !== 'pdf.removePages') continue;
    for (const page of operation.pages) remove.add(page - 1);
  }
  for (const index of [...remove].sort((left, right) => right - left)) {
    doc.removePage(index);
  }
  return Buffer.from(await doc.save());
}

async function deleteSiblingVariants(
  root: string,
  tenantId: string,
  assetId: string,
): Promise<void> {
  const { readdir, rm } = await import('node:fs/promises');
  const { tenantPath } = await import('../ids.js');
  const dir = path.join(root, tenantPath(tenantId));
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter(
        (name) =>
          name.startsWith(`${assetId}_`) && !name.includes('_original.'),
      )
      .map((name) => rm(path.join(dir, name), { force: true })),
  );
}

function readFile(file: string): Buffer {
  return readFileSync(file);
}
