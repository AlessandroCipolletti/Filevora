import { fail } from '../errors/error.js';

/** Exact types win over `image/*` wildcards, then the global max. */
export function maxBytesForType(
  mime: string,
  limits: Record<string, number>,
  fallback: number,
): number {
  if (limits[mime] !== undefined) return limits[mime] ?? fallback;
  const wildcard = `${mime.split('/')[0]}/*`;
  if (limits[wildcard] !== undefined) return limits[wildcard] ?? fallback;
  return fallback;
}

export function assertDetectedSize(
  mime: string,
  bytes: number,
  limits: Record<string, number>,
  fallback: number,
): void {
  const maxBytes = maxBytesForType(mime, limits, fallback);
  if (bytes > maxBytes) {
    throw fail('FILE_TOO_LARGE', {
      message: `${mime} is larger than the limit for that detected type.`,
      context: { detectedType: mime, maxBytes, bytes },
    });
  }
}

export function parseTypeLimits(
  raw: string | undefined,
): Record<string, number> {
  const limits: Record<string, number> = {};
  if (!raw) return limits;
  for (const item of raw.split(',')) {
    const [mime, size] = item.split('=').map((part) => part.trim());
    if (!mime || !size || !/^\d+$/.test(size)) continue;
    limits[mime.toLowerCase()] = Number(size);
  }
  return limits;
}
