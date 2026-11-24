import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { nowIso } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { readAll } from '../storage/stage.js';
import type { StorageDriver } from '../types/index.js';
import { askGemini } from './gemini.js';

const LONG_LIMIT = 3000;
const SHORT_LIMIT = 300;
const TAG_LIMIT = 12;

const VISUAL = ['subject', 'action', 'style', 'purpose', 'emotion'] as const;
const AUDIO = ['kind', 'language'] as const;
const TEXT = ['subject', 'purpose', 'language'] as const;
const KINDS = new Set(['music', 'sound-effects', 'speech']);

interface AssetRow {
  id: string;
  tenant_id: string;
  detected_mime: string | null;
  declared_mime: string;
  original_object_key: string | null;
  describe_requested: number | null;
  description_status: string | null;
}

export async function runAssetDescription(
  sql: Sql,
  storage: StorageDriver,
  config: ResolvedConfig,
  fileId: string,
): Promise<void> {
  const row = await sql.get<AssetRow>(
    `SELECT id, tenant_id, detected_mime, declared_mime, original_object_key,
            describe_requested, description_status
     FROM files WHERE id = ?`,
    [fileId],
  );
  if (!row || row.describe_requested !== 1) return;
  if (
    row.description_status === 'done' ||
    row.description_status === 'failed'
  ) {
    return;
  }
  const mime = row.detected_mime || row.declared_mime;
  try {
    const source = await sourceBytes(sql, storage, config, row, mime);
    const result = await askGemini({
      apiKey: config.gemini.apiKey,
      model: config.gemini.model,
      mimeType: source.mime,
      bytes: source.bytes,
      prompt: promptFor(mime),
      retryDelayMs: config.gemini.retryDelayMs,
      ...(config.gemini.fetchImpl
        ? { fetchImpl: config.gemini.fetchImpl }
        : {}),
    });
    const tags = normaliseTags(result.tags, mime);
    const long = clip(result.descriptionLong, LONG_LIMIT);
    const short = clip(result.descriptionShort, SHORT_LIMIT);
    const now = nowIso();
    await sql.transaction(async () => {
      await sql.run(
        `UPDATE files SET description_long = ?, description_short = ?, description_status = 'done',
         description_error = NULL, described_at = ?, description_model = ?, updated_at = ? WHERE id = ?`,
        [long, short, now, config.gemini.model, now, fileId],
      );
      await sql.run('DELETE FROM filevora_asset_tags WHERE asset_id = ?', [
        fileId,
      ]);
      for (const tag of tags) {
        await sql.run(
          'INSERT INTO filevora_asset_tags (asset_id, tag, category) VALUES (?, ?, ?)',
          [fileId, tag.tag, tag.category],
        );
      }
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'The description failed.';
    await sql
      .run(
        `UPDATE files SET description_status = 'failed', description_error = ?, updated_at = ? WHERE id = ?`,
        [clip(message, 300), nowIso(), fileId],
      )
      .catch(() => undefined);
  }
}

function promptFor(mime: string): string {
  const categories = allowedCategories(mime).join(', ');
  return [
    `MEDIA: ${mime}`,
    'Describe this asset for a private media library.',
    `description_long is at most ${LONG_LIMIT} characters.`,
    `description_short is at most ${SHORT_LIMIT} characters.`,
    `tags use only these categories: ${categories}.`,
    'Image and video tags cover subject, action, style, purpose, and emotion.',
    'Audio kind is music, sound-effects, or speech. Speech also gets a language tag (ISO code). Speech descriptions summarise what is said. Music and effects describe the sound.',
    'Text and PDF tags cover subject, purpose, and language. The descriptions are summaries.',
    'Lowercase the tags. At most 12 tags. Do not invent categories.',
  ].join(' ');
}

async function sourceBytes(
  sql: Sql,
  storage: StorageDriver,
  config: ResolvedConfig,
  row: AssetRow,
  mime: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const variant = await sql.get<{ storage_key: string; mime: string }>(
    `SELECT storage_key, mime FROM variants
     WHERE file_id = ? AND name = 'optimized' AND status = 'ready'`,
    [row.id],
  );
  const key = variant?.storage_key ?? row.original_object_key;
  const sourceMime = variant?.mime ?? mime;
  if (!key) throw new Error('The asset has no bytes to describe.');
  const bytes = await readAll(await storage.getObject(key));
  if (mime.startsWith('audio/')) {
    const mono = await monoAudio(bytes, config.processing.ffmpegPath);
    if (mono) return { bytes: mono, mime: 'audio/mp4' };
  }
  if (mime.startsWith('video/') && config.gemini.videoHeight !== 720) {
    const scaled = await scaleVideo(
      bytes,
      config.processing.ffmpegPath,
      config.gemini.videoHeight,
    );
    if (scaled) return { bytes: scaled, mime: 'video/mp4' };
  }
  return { bytes, mime: sourceMime };
}

function allowedCategories(mime: string): readonly string[] {
  if (mime.startsWith('image/') || mime.startsWith('video/')) return VISUAL;
  if (mime.startsWith('audio/')) return AUDIO;
  return TEXT;
}

export function normaliseTags(
  tags: Array<{ category: string; tag: string }>,
  mime: string,
): Array<{ category: string; tag: string }> {
  const allowed = new Set(allowedCategories(mime));
  const seen = new Set<string>();
  const output: Array<{ category: string; tag: string }> = [];
  for (const entry of tags) {
    const category = entry.category.trim().toLowerCase();
    const tag = entry.tag.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!allowed.has(category) || !/^[a-z0-9][a-z0-9 -]{0,40}$/.test(tag)) {
      continue;
    }
    if (category === 'kind' && !KINDS.has(tag)) continue;
    const key = `${category}:${tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ category, tag });
    if (output.length >= TAG_LIMIT) break;
  }
  return output;
}

export function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function monoAudio(
  bytes: Uint8Array,
  ffmpeg: string,
): Promise<Uint8Array | undefined> {
  return transcode(
    bytes,
    ffmpeg,
    ['-ac', '1', '-c:a', 'aac', '-b:a', '64k'],
    'm4a',
  );
}

function scaleVideo(
  bytes: Uint8Array,
  ffmpeg: string,
  height: number,
): Promise<Uint8Array | undefined> {
  return transcode(
    bytes,
    ffmpeg,
    [
      '-vf',
      `scale=-2:${height}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-an',
    ],
    'mp4',
  );
}

function transcode(
  bytes: Uint8Array,
  ffmpeg: string,
  args: string[],
  extension: string,
): Promise<Uint8Array | undefined> {
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-describe-'));
  const input = path.join(work, 'in.bin');
  const output = path.join(work, `out.${extension}`);
  writeFileSync(input, bytes);
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-y', '-i', input, ...args, output], {
      stdio: 'ignore',
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', () => {
      clearTimeout(timer);
      rmSync(work, { recursive: true, force: true });
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const body = code === 0 ? readFileSync(output) : undefined;
      rmSync(work, { recursive: true, force: true });
      resolve(body);
    });
  });
}
