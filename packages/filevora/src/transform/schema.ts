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
    atPercent: z.number().min(0).max(100).optional(),
    width: z.number().int().min(2).max(1920).optional(),
  })
  .strict();

const videoThumbnails = z
  .object({
    op: z.literal('video.thumbnails'),
    count: z.number().int().min(1).max(48).optional(),
    width: z.number().int().min(2).max(1920).optional(),
    intervalMs: z.number().int().min(1).optional(),
    atMs: z.array(z.number().int().min(0)).min(1).max(48).optional(),
    atPercent: z.array(z.number().min(0).max(100)).min(1).max(48).optional(),
  })
  .strict();

const videoSprite = z
  .object({
    op: z.literal('video.sprite'),
    columns: z.number().int().min(1).max(10),
    rows: z.number().int().min(1).max(10),
    cellWidth: z.number().int().min(2).max(640).optional(),
    intervalMs: z.number().int().min(1).optional(),
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

const pdfPages = z
  .object({
    op: z.literal('pdf.pages'),
    pages: z.array(z.number().int().min(1)).min(1).max(50).optional(),
    width: z.number().int().min(16).max(4096).optional(),
    height: z.number().int().min(16).max(4096).optional(),
    format: z.enum(['png', 'jpeg', 'webp']).optional(),
    dpi: z.number().int().min(36).max(300).optional(),
  })
  .strict();

export const assetTransformOperationSchema = z.discriminatedUnion('op', [
  imageResize,
  imageCrop,
  videoResize,
  videoCrop,
  videoTrim,
  videoPoster,
  videoThumbnails,
  videoSprite,
  pdfRemovePages,
  pdfPages,
]);

export const FRAME_OPERATIONS = [
  'video.poster',
  'video.thumbnails',
  'video.sprite',
] as const;

export function isFrameOperation(op: string): boolean {
  return (FRAME_OPERATIONS as readonly string[]).includes(op);
}

export function isPdfPageOperation(op: string): boolean {
  return op === 'pdf.pages';
}

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
    return [
      'video.resize',
      'video.crop',
      'video.trim',
      'video.poster',
      'video.thumbnails',
      'video.sprite',
    ];
  if (family === 'pdf') return ['pdf.removePages', 'pdf.pages'];
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
          'video.poster',
          'video.thumbnails',
          'video.sprite',
          'pdf.removePages',
          'pdf.pages',
        ],
      },
    });
  }
  const operations = parsed.data.operations;
  const pageOps = operations.filter(
    (operation) => operation.op === 'pdf.pages',
  );
  if (pageOps.length > 1) {
    reject(
      'operations',
      'Send one pdf.pages operation. List every page in its pages array.',
      'application/pdf',
      validOperations('application/pdf'),
    );
  }
  operations.forEach((operation, index) =>
    assertFrameOptions(operation, `operations[${index}]`),
  );
  return {
    replace: parsed.data.replace !== false,
    operations,
  };
}

export function assertFrameOptions(
  operation: AssetTransformOperation,
  field: string,
): void {
  if (operation.op === 'video.poster') {
    if (operation.atMs !== undefined && operation.atPercent !== undefined) {
      reject(
        `${field}.atPercent`,
        'Use atMs or atPercent, not both.',
        'video',
        validOperations('video/mp4'),
      );
    }
  }
  if (operation.op === 'video.thumbnails') {
    const chosen = [
      operation.atMs,
      operation.atPercent,
      operation.intervalMs,
    ].filter((item) => item !== undefined);
    if (chosen.length > 1) {
      reject(
        `${field}.atMs`,
        'Use one of atMs, atPercent, or intervalMs.',
        'video',
        validOperations('video/mp4'),
      );
    }
    if (chosen.length === 0 && operation.count === undefined) {
      reject(
        `${field}.count`,
        'Set count, intervalMs, atMs, or atPercent.',
        'video',
        validOperations('video/mp4'),
      );
    }
  }
  if (
    operation.op === 'video.sprite' &&
    operation.columns * operation.rows > 48
  ) {
    reject(
      `${field}.rows`,
      'A sprite sheet can hold at most 48 frames.',
      'video',
      validOperations('video/mp4'),
    );
  }
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
    if (isFrameOperation(operation.op)) {
      reject(
        `${field}.op`,
        `${operation.op} is stored as a version. Send it without video.resize, video.crop, or video.trim, or use a poster, thumbnails, or sprites preset.`,
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
    if (operation.op === 'pdf.pages') {
      reject(
        `${field}.op`,
        'pdf.pages is stored as a version. Send it without pdf.removePages, or use preset pdf-pages or pdf-cover.',
        mime,
        allowed,
      );
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
