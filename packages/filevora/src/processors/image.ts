import { fail } from '../errors/error.js';
import { assetObjectKey, createId, nowIso, sha256 } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import type { ExifMode } from '../safety/exif.js';
import { materialize } from '../storage/stage.js';
import type { StorageDriver } from '../types/index.js';

const TARGETS = [
  { name: 'thumbnail', width: 320 },
  { name: 'optimized', width: 1280 },
  { name: 'hd', width: 1920 },
] as const;

interface ImageFile {
  id: string;
  tenant_id: string;
  detected_mime: string | null;
  original_object_key: string | null;
}

/**
 * Build the web-optimized image variants with Sharp.
 * Outputs are WebP, metadata is not copied, and images are not enlarged.
 */
export async function publishImagePreset(
  sql: Sql,
  storage: StorageDriver,
  file: ImageFile,
  maxPixels: number,
  exif: ExifMode = 'gps',
): Promise<string[]> {
  if (!file.original_object_key) throw fail('NOT_FOUND');
  const sharp = await loadSharp();
  const local = await materialize(storage, file.original_object_key);
  const input = local.path;
  try {
    return await publishImageFromPath(
      sql,
      storage,
      file,
      maxPixels,
      exif,
      sharp,
      input,
    );
  } finally {
    await local.cleanup();
  }
}

async function publishImageFromPath(
  sql: Sql,
  storage: StorageDriver,
  file: ImageFile,
  maxPixels: number,
  exif: ExifMode,
  sharp: Awaited<ReturnType<typeof loadSharp>>,
  input: string,
): Promise<string[]> {
  let source: { width?: number; height?: number };
  try {
    source = await sharp(input, { limitInputPixels: maxPixels }).metadata();
  } catch (error) {
    throw fail('INVALID_RECIPE', {
      message:
        error instanceof Error ? error.message : 'The image could not be read.',
    });
  }
  const pixels = (source.width ?? 0) * (source.height ?? 0);
  if (!source.width || !source.height || pixels > maxPixels) {
    throw fail('INVALID_RECIPE', {
      message: 'The image exceeds the pixel limit.',
    });
  }
  const names: string[] = [];
  for (const target of TARGETS) {
    const existing = await sql.get<{ id: string }>(
      `SELECT id FROM variants WHERE file_id = ? AND name = ? AND recipe_id = ? AND recipe_version = ?`,
      [file.id, target.name, 'web-optimized', 1],
    );
    if (existing) {
      names.push(target.name);
      continue;
    }
    let pipeline = sharp(input, { limitInputPixels: maxPixels })
      .rotate()
      .resize({ width: target.width, withoutEnlargement: true });
    if (exif === 'none') pipeline = pipeline.withMetadata();
    const body = await pipeline.webp({ quality: 80 }).toBuffer();
    const info = await sharp(body).metadata();
    const id = createId('variant');
    const key = assetObjectKey(file.tenant_id, file.id, target.name, 'webp');
    await storage.putObject({
      key,
      body,
      contentType: 'image/webp',
    });
    await sql.run(
      `INSERT INTO variants (
        id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, width, height,
        duration_ms, checksum, status, created_at
      ) VALUES (?, ?, ?, 'web-optimized', 1, ?, 'image/webp', ?, ?, ?, NULL, ?, 'ready', ?)`,
      [
        id,
        file.id,
        target.name,
        key,
        body.byteLength,
        info.width ?? null,
        info.height ?? null,
        sha256(body),
        nowIso(),
      ],
    );
    names.push(target.name);
  }
  await sql.run(
    `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
    [nowIso(), file.id],
  );
  return names;
}

async function loadSharp() {
  try {
    const imported = await import('sharp');
    return imported.default;
  } catch {
    throw fail('PROCESSOR_UNAVAILABLE', {
      message:
        'Image processing needs the optional sharp package. Install it with npm install sharp.',
    });
  }
}
