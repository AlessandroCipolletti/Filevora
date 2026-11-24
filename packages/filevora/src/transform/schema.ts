import { z } from 'zod';
import { fail } from '../errors/error.js';

const imageResize = z
  .object({
    op: z.literal('image.resize'),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192).optional(),
    fit: z.enum(['cover', 'contain', 'fill']).optional(),
  })
  .strict();

const imageCrop = z
  .object({
    op: z.literal('image.crop'),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  })
  .strict();

const videoResize = z
  .object({
    op: z.literal('video.resize'),
    width: z.number().int().min(2).max(1920).optional(),
    height: z.number().int().min(2).max(1080),
  })
  .strict();

const videoPoster = z
  .object({
    op: z.literal('video.poster'),
    atMs: z.number().int().min(0).optional(),
    width: z.number().int().min(2).max(1920).optional(),
  })
  .strict();

const videoCrop = z
  .object({
    op: z.literal('video.crop'),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    width: z.number().int().min(2),
    height: z.number().int().min(2),
  })
  .strict();

const videoTrim = z
  .object({
    op: z.literal('video.trim'),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
  })
  .strict();

const pdfRemovePages = z
  .object({
    op: z.literal('pdf.removePages'),
    pages: z.array(z.number().int().min(1)).min(1).max(500),
  })
  .strict();

export const assetTransformOperationSchema = z.discriminatedUnion('op', [
  imageResize,
  imageCrop,
  videoResize,
  videoCrop,
  videoTrim,
  videoPoster,
  pdfRemovePages,
]);

/** One transform request. `replace` defaults to true. */
export const assetTransformSchema = z
  .object({
    replace: z.boolean().optional(),
    operations: z.array(assetTransformOperationSchema).min(1).max(8),
  })
  .strict();

export type AssetTransformOperation = z.infer<
  typeof assetTransformOperationSchema
>;
export type AssetTransform = z.infer<typeof assetTransformSchema>;
export type AssetTransformInput = z.input<typeof assetTransformSchema>;

export type MediaFamily = 'image' | 'video' | 'pdf' | 'other';

export function mediaFamily(mime: string | null | undefined): MediaFamily {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'other';
}

export function validOperations(mime: string | null | undefined): string[] {
  const family = mediaFamily(mime);
  if (family === 'image') return ['image.resize', 'image.crop'];
  if (family === 'video')
    return ['video.resize', 'video.crop', 'video.trim', 'video.poster'];
  if (family === 'pdf') return ['pdf.removePages'];
  return [];
}

export function parseAssetTransform(input: unknown): AssetTransform {
  const parsed = assetTransformSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const unknownKey =
      issue && 'keys' in issue && Array.isArray(issue.keys)
        ? String(issue.keys[0])
        : undefined;
    const field = unknownKey || issue?.path.join('.') || 'operations';
    throw fail('TRANSFORM_REJECTED', {
      message: issue?.message ?? 'The transform config is invalid.',
      context: {
        field: field.replace(/\.(\d+)/g, '[$1]'),
        reason: issue?.message ?? 'Invalid value.',
        detectedType: null,
        validOperations: [
          'image.resize',
          'image.crop',
          'video.resize',
          'video.crop',
          'video.trim',
          'pdf.removePages',
        ],
      },
    });
  }
  return {
    replace: parsed.data.replace !== false,
    operations: parsed.data.operations,
  };
}

export interface MediaBounds {
  width?: number;
  height?: number;
  durationMs?: number;
  pageCount?: number;
}

/** Reject operations that do not match the sniffed type or the measured frame. */
export function assertTransformFits(
  operations: AssetTransformOperation[],
  mime: string,
  bounds: MediaBounds,
): void {
  const family = mediaFamily(mime);
  const allowed = validOperations(mime);
  if (family === 'other' || allowed.length === 0) {
    reject('operations', `No transform is valid for ${mime}.`, mime, allowed);
  }
  operations.forEach((operation, index) => {
    const field = `operations[${index}]`;
    const opFamily = operation.op.split('.')[0];
    if (opFamily !== family) {
      reject(
        `${field}.op`,
        `${operation.op} is not valid for ${mime}.`,
        mime,
        allowed,
      );
    }
    if (operation.op === 'image.crop' || operation.op === 'video.crop') {
      if (
        bounds.width === undefined ||
        bounds.height === undefined ||
        operation.x + operation.width > bounds.width ||
        operation.y + operation.height > bounds.height
      ) {
        reject(
          `${field}.width`,
          `Crop ${operation.width}x${operation.height} at ${operation.x},${operation.y} is outside ${bounds.width ?? 0}x${bounds.height ?? 0}.`,
          mime,
          allowed,
        );
      }
    }
    if (operation.op === 'video.poster') {
      reject(
        `${field}.op`,
        'video.poster is stored as a version. Use preset "poster".',
        mime,
        allowed,
      );
    }
    if (operation.op === 'video.resize' || operation.op === 'video.crop') {
      const width = 'width' in operation ? operation.width : undefined;
      if (
        operation.height % 2 !== 0 ||
        (width !== undefined && width % 2 !== 0)
      ) {
        reject(
          `${field}.width`,
          'Video width and height must be even.',
          mime,
          allowed,
        );
      }
    }
    if (operation.op === 'video.trim') {
      if (operation.endMs <= operation.startMs) {
        reject(
          `${field}.endMs`,
          'Trim end must be after the start.',
          mime,
          allowed,
        );
      }
      if (
        bounds.durationMs !== undefined &&
        bounds.durationMs > 0 &&
        operation.endMs > bounds.durationMs + 50
      ) {
        reject(
          `${field}.endMs`,
          `Trim end ${operation.endMs}ms is past the ${bounds.durationMs}ms video.`,
          mime,
          allowed,
        );
      }
    }
    if (operation.op === 'pdf.removePages') {
      const count = bounds.pageCount ?? 0;
      const unique = new Set(operation.pages);
      if (unique.size !== operation.pages.length) {
        reject(`${field}.pages`, 'Page numbers must be unique.', mime, allowed);
      }
      const missing = operation.pages.find((page) => page < 1 || page > count);
      if (missing !== undefined || count === 0) {
        reject(
          `${field}.pages`,
          `Page ${missing ?? '?'} is outside 1..${count}.`,
          mime,
          allowed,
        );
      }
      if (unique.size >= count) {
        reject(
          `${field}.pages`,
          'At least one PDF page must remain.',
          mime,
          allowed,
        );
      }
    }
  });
}

function reject(
  field: string,
  reason: string,
  detectedType: string,
  operations: string[],
): never {
  throw fail('TRANSFORM_REJECTED', {
    message: `${field} is invalid: ${reason}`,
    context: {
      field,
      reason,
      detectedType,
      validOperations: operations,
    },
  });
}
