import type { ResolvedConfig } from '../config/load.js';
import { nowIso } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { redactString } from '../redact.js';
import { kindFromMime } from '../server/asset-info.js';
import {
  buildCanonicalEmbeddingText,
  embedConfigFrom,
  embedDocument,
  type EmbedFile,
} from '../search/embed.js';
import {
  EMBED_FILE_LIMITS,
  embeddingFileKind,
  isEmbeddableMedia,
  prepareEmbeddingFile,
  type EmbeddingFileKind,
} from '../search/embed-file.js';
import { readAll } from '../storage/stage.js';
import type { StorageDriver } from '../types/index.js';

export interface EmbedAssetRow {
  id: string;
  tenant_id: string;
  original_name: string;
  original_object_key: string | null;
  bytes: number | null;
}

interface VariantRow {
  name: string;
  storage_key: string;
  mime: string;
  bytes: number | null;
  duration_ms: number | null;
}

function log(assetId: string, message: string): void {
  process.stderr.write(
    `filevora: embedding for ${assetId}: ${redactString(message)}\n`,
  );
}

/**
 * Embed the asset's file together with its description. A failed embedding never discards a
 * finished description; the asset is just not searchable yet. A file that cannot be sent is
 * logged and the description alone is embedded.
 */
export async function embedAsset(
  sql: Sql,
  storage: StorageDriver,
  config: ResolvedConfig,
  row: EmbedAssetRow,
  mime: string,
  description: {
    short: string;
    long: string;
    tags: Array<{ category: string; tag: string }>;
  },
): Promise<void> {
  try {
    const canonical = buildCanonicalEmbeddingText({
      assetType: kindFromMime(mime),
      mime,
      originalName: row.original_name,
      descriptionShort: description.short,
      descriptionLong: description.long,
      tags: description.tags,
    });
    const prepared = await loadEmbeddingFile(sql, storage, config, row, mime);
    if ('reason' in prepared) {
      log(row.id, `embedding the description only (${prepared.reason}).`);
    }
    const { vector, source } = await embedDocument(
      embedConfigFrom(config),
      {
        text: canonical.text,
        title: canonical.title,
        ...('file' in prepared ? { file: prepared.file } : {}),
      },
      (message) => log(row.id, message),
    );
    const embedding = Buffer.from(
      vector.buffer,
      vector.byteOffset,
      vector.byteLength,
    );
    await sql.transaction(async () => {
      await sql.run(
        'DELETE FROM filevora_asset_embeddings WHERE asset_id = ?',
        [row.id],
      );
      await sql.run(
        `INSERT INTO filevora_asset_embeddings
         (asset_id, tenant_id, model, dimensions, embedding, source, content_hash, embedded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.tenant_id,
          config.gemini.embeddingModel,
          config.gemini.embeddingDimensions,
          embedding,
          source,
          canonical.contentHash,
          nowIso(),
        ],
      );
    });
  } catch (error) {
    await sql
      .run('DELETE FROM filevora_asset_embeddings WHERE asset_id = ?', [row.id])
      .catch(() => undefined);
    const detail = error instanceof Error ? error.message : 'unknown failure';
    log(row.id, `failed: ${detail}`);
  }
}

type Loaded = { file: EmbedFile; rendition: string } | { reason: string };

/** Never throws: a file that cannot be read or rendered means the description alone is embedded. */
async function loadEmbeddingFile(
  sql: Sql,
  storage: StorageDriver,
  config: ResolvedConfig,
  row: EmbedAssetRow,
  mime: string,
): Promise<Loaded> {
  const kind = embeddingFileKind(mime);
  if (!kind) return { reason: `${mime} is not embedded as a file` };
  try {
    const variants = await sql.all<VariantRow>(
      `SELECT name, storage_key, mime, bytes, duration_ms FROM variants
       WHERE file_id = ? AND status = 'ready' AND recipe_id = 'web-optimized'`,
      [row.id],
    );
    const common = {
      ffprobePath: config.processing.ffprobePath,
      maxPixels: config.processing.imageMaxPixels,
    };
    if (kind === 'image') {
      const variant = variants.find((entry) => entry.name === 'optimized');
      const key = variant?.storage_key ?? row.original_object_key;
      if (!key) return { reason: 'the asset has no stored bytes' };
      if (
        !variant &&
        (row.bytes ?? 0) > EMBED_FILE_LIMITS.maxImageSourceBytes
      ) {
        return { reason: `the original image is ${row.bytes} bytes` };
      }
      const bytes = await readAll(await storage.getObject(key));
      return await prepareEmbeddingFile({
        ...common,
        bytes,
        mime: variant?.mime ?? mime,
      });
    }
    if (kind === 'video' || kind === 'audio') {
      return await loadMedia(storage, row, mime, kind, variants, common);
    }
    if (!row.original_object_key) {
      return { reason: 'the asset has no stored bytes' };
    }
    if ((row.bytes ?? 0) > EMBED_FILE_LIMITS.maxFileBytes) {
      return { reason: `the PDF is ${row.bytes} bytes` };
    }
    const bytes = await readAll(
      await storage.getObject(row.original_object_key),
    );
    return await prepareEmbeddingFile({ ...common, bytes, mime });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    return { reason: `could not read the file: ${detail}` };
  }
}

async function loadMedia(
  storage: StorageDriver,
  row: EmbedAssetRow,
  mime: string,
  kind: EmbeddingFileKind,
  variants: VariantRow[],
  common: { ffprobePath: string; maxPixels: number },
): Promise<Loaded> {
  const limitMs =
    (kind === 'audio'
      ? EMBED_FILE_LIMITS.audioSeconds
      : EMBED_FILE_LIMITS.videoSeconds) * 1000;
  const sameKind = variants.filter((entry) =>
    entry.mime.startsWith(`${kind}/`),
  );
  const longest = Math.max(
    0,
    ...sameKind.map((entry) => entry.duration_ms ?? 0),
  );
  if (longest > limitMs) {
    return {
      reason: `the ${kind} lasts ${Math.round(longest / 1000)} s; the limit is ${limitMs / 1000} s`,
    };
  }
  const usable = sameKind
    .filter(
      (entry) =>
        isEmbeddableMedia(kind, entry.mime) &&
        entry.duration_ms !== null &&
        (entry.bytes ?? Infinity) <= EMBED_FILE_LIMITS.maxFileBytes,
    )
    .sort((left, right) => (left.bytes ?? 0) - (right.bytes ?? 0))[0];
  if (usable) {
    const bytes = await readAll(await storage.getObject(usable.storage_key));
    return await prepareEmbeddingFile({
      ...common,
      bytes,
      mime: usable.mime,
      durationMs: usable.duration_ms ?? 0,
    });
  }
  if (!isEmbeddableMedia(kind, mime)) {
    return {
      reason: `no MP4, MOV, MP3 or WAV rendition exists and the original is ${mime}`,
    };
  }
  if (!row.original_object_key)
    return { reason: 'the asset has no stored bytes' };
  if ((row.bytes ?? 0) > EMBED_FILE_LIMITS.maxFileBytes) {
    return { reason: `the original ${kind} is ${row.bytes} bytes` };
  }
  const bytes = await readAll(await storage.getObject(row.original_object_key));
  return await prepareEmbeddingFile({ ...common, bytes, mime });
}
