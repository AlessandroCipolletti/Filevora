import type {
  AssetInfo,
  AssetKind,
  AssetProcessingStatus,
  AssetVersionInfo,
  FileRecord,
  ProcessingState,
} from '../types/index.js';

const KIND_BY_MIME: Array<[RegExp, AssetKind]> = [
  [/^image\//, 'image'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
  [/^application\/pdf$/, 'pdf'],
  [/^text\/csv$/, 'tabular'],
  [/spreadsheetml/, 'tabular'],
];

export function kindFromMime(mime: string | null | undefined): AssetKind {
  if (!mime) return 'other';
  return KIND_BY_MIME.find(([pattern]) => pattern.test(mime))?.[1] ?? 'other';
}

export function processingStatusFor(
  state: ProcessingState,
): AssetProcessingStatus {
  if (state === 'queued') return 'queued';
  if (state === 'processing' || state === 'retrying') return 'processing';
  if (state === 'ready') return 'completed';
  if (state === 'partially_ready') return 'partial';
  if (state === 'failed' || state === 'deleted') return 'failed';
  return 'none';
}

/** One shape for upload, get, and delivery so an agent can map fields once. */
export function toAssetInfo(
  record: FileRecord,
  opts: { detailed: boolean; originalUrl?: string } = { detailed: true },
): AssetInfo {
  const mime = record.detectedMime ?? record.declaredMime;
  const versions: Record<string, AssetVersionInfo> = {};
  if (record.uploadState === 'verified') {
    versions._original = {
      version: '_original',
      status: 'ready',
      mime,
      bytes: record.bytes,
      ...(opts.originalUrl ? { url: opts.originalUrl } : {}),
    };
  }
  for (const variant of record.variants) {
    versions[variant.name] = {
      version: variant.name,
      status: variant.status === 'ready' ? 'ready' : 'failed',
      mime: variant.mimeType,
      bytes: variant.bytes,
      ...(opts.detailed && variant.width ? { width: variant.width } : {}),
      ...(opts.detailed && variant.height ? { height: variant.height } : {}),
      ...(opts.detailed && variant.durationMs
        ? { durationMs: variant.durationMs }
        : {}),
    };
  }
  return {
    assetId: record.id,
    kind: kindFromMime(mime),
    processingStatus: processingStatusFor(record.processingState),
    versions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
