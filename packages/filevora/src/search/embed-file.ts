import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { probeMedia } from '../processors/ffmpeg.js';
import { loadSharp } from '../processors/image.js';
import { redactString } from '../redact.js';
import type { EmbedFile } from './embed.js';

const MIB = 1024 * 1024;

/** Input limits of gemini-embedding-2 plus the sizes this pipeline chooses to send. */
export const EMBED_FILE_LIMITS = {
  /** Longest side of the JPEG or PNG rendition. Google counts a fixed 258 tokens per image. */
  imageLongEdge: 1024,
  jpegQuality: 85,
  /** Largest file sent inline. Base64 adds a third, and a request may not pass 20 MiB. */
  maxFileBytes: 12 * MIB,
  /** Largest image source read into memory before the rendition is made. */
  maxImageSourceBytes: 64 * MIB,
  audioSeconds: 180,
  videoSeconds: 120,
  pdfPages: 6,
} as const;

const AUDIO_MIMES: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/wav': 'audio/wav',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
};
const VIDEO_MIMES: Record<string, string> = {
  'video/mp4': 'video/mp4',
  'video/quicktime': 'video/quicktime',
};
const VIDEO_CODECS = new Set(['h264', 'hevc', 'av1', 'vp9']);

export type EmbeddingFileKind = 'image' | 'video' | 'audio' | 'pdf';

export function embeddingFileKind(mime: string): EmbeddingFileKind | undefined {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  return undefined;
}

export function isEmbeddableMedia(kind: EmbeddingFileKind, mime: string) {
  const type = mime.toLowerCase().split(';')[0]?.trim() ?? '';
  if (kind === 'audio') return type in AUDIO_MIMES;
  if (kind === 'video') return type in VIDEO_MIMES;
  return true;
}

export type PreparedEmbeddingFile =
  { file: EmbedFile; rendition: string } | { reason: string };

export interface PrepareInput {
  bytes: Uint8Array;
  mime: string;
  /** Known duration of a rendition made by our own pipeline. Probed with ffprobe when absent. */
  durationMs?: number;
  ffprobePath: string;
  maxPixels: number;
}

/**
 * Turn the stored bytes into a file Google accepts, or say why the description alone must be
 * embedded. Never throws: every failure becomes a reason.
 */
export async function prepareEmbeddingFile(
  input: PrepareInput,
): Promise<PreparedEmbeddingFile> {
  const kind = embeddingFileKind(input.mime);
  if (!kind) return { reason: `${input.mime} is not embedded as a file` };
  try {
    if (kind === 'image') return await renderImage(input);
    if (kind === 'pdf') return await checkPdf(input);
    return await checkMedia(kind, input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    return { reason: `${kind} rendition failed: ${redactString(detail)}` };
  }
}

async function renderImage(
  input: PrepareInput,
): Promise<PreparedEmbeddingFile> {
  const sharp = await loadSharp();
  const source = Buffer.from(input.bytes);
  const open = () => sharp(source, { limitInputPixels: input.maxPixels });
  const metadata = await open().metadata();
  const transparent = metadata.hasAlpha
    ? !(await open().stats()).isOpaque
    : false;
  const resized = open().rotate().resize({
    width: EMBED_FILE_LIMITS.imageLongEdge,
    height: EMBED_FILE_LIMITS.imageLongEdge,
    fit: 'inside',
    withoutEnlargement: true,
  });
  const body = transparent
    ? await resized.png({ compressionLevel: 9 }).toBuffer()
    : await resized
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: EMBED_FILE_LIMITS.jpegQuality })
        .toBuffer();
  if (body.byteLength > EMBED_FILE_LIMITS.maxFileBytes) {
    return { reason: `the image rendition is ${body.byteLength} bytes` };
  }
  const mime = transparent ? 'image/png' : 'image/jpeg';
  return {
    file: { bytes: new Uint8Array(body), mime },
    rendition: `${mime};long-edge=${EMBED_FILE_LIMITS.imageLongEdge}`,
  };
}

async function checkPdf(input: PrepareInput): Promise<PreparedEmbeddingFile> {
  if (input.bytes.byteLength > EMBED_FILE_LIMITS.maxFileBytes) {
    return { reason: `the PDF is ${input.bytes.byteLength} bytes` };
  }
  const pdf = await PDFDocument.load(input.bytes, { updateMetadata: false });
  const pages = pdf.getPageCount();
  if (pages > EMBED_FILE_LIMITS.pdfPages) {
    return {
      reason: `the PDF has ${pages} pages; the limit is ${EMBED_FILE_LIMITS.pdfPages}`,
    };
  }
  return {
    file: { bytes: input.bytes, mime: 'application/pdf' },
    rendition: 'application/pdf;original',
  };
}

async function checkMedia(
  kind: 'video' | 'audio',
  input: PrepareInput,
): Promise<PreparedEmbeddingFile> {
  const type = input.mime.toLowerCase().split(';')[0]?.trim() ?? '';
  const mime = (kind === 'audio' ? AUDIO_MIMES : VIDEO_MIMES)[type];
  if (!mime) {
    return {
      reason:
        kind === 'audio'
          ? `${type} is not MP3 or WAV`
          : `${type} is not MP4 or MOV`,
    };
  }
  if (input.bytes.byteLength > EMBED_FILE_LIMITS.maxFileBytes) {
    return { reason: `the ${kind} is ${input.bytes.byteLength} bytes` };
  }
  const limitSeconds =
    kind === 'audio'
      ? EMBED_FILE_LIMITS.audioSeconds
      : EMBED_FILE_LIMITS.videoSeconds;
  let durationMs = input.durationMs;
  if (durationMs === undefined) {
    const probe = await probeBytes(input);
    durationMs = probe.durationMs;
    if (
      kind === 'video' &&
      !VIDEO_CODECS.has((probe.videoCodec ?? '').toLowerCase())
    ) {
      return {
        reason: `the video codec ${probe.videoCodec ?? 'unknown'} is not H264, H265, AV1 or VP9`,
      };
    }
  }
  if (durationMs > limitSeconds * 1000) {
    return {
      reason: `the ${kind} lasts ${Math.round(durationMs / 1000)} s; the limit is ${limitSeconds} s`,
    };
  }
  return {
    file: { bytes: input.bytes, mime },
    rendition: input.durationMs === undefined ? `${mime};original` : mime,
  };
}

async function probeBytes(input: PrepareInput) {
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-embed-'));
  try {
    const file = path.join(work, 'probe.bin');
    writeFileSync(file, input.bytes);
    return await probeMedia(input.ffprobePath, file, 15_000);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
