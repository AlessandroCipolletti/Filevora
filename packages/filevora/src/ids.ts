import { createHash, randomBytes } from 'node:crypto';

/** Opaque id. The prefix is for logs; it is not an authorization boundary. */
export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stable path segment for a tenant id. Not reversible to the original id. */
export function tenantPath(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 32);
}

/**
 * Object name `{assetId}_{version}.{ext}` under the tenant prefix.
 * The asset id itself stays in the metadata database. Redis does not name files.
 */
export function assetObjectKey(
  tenantId: string,
  assetId: string,
  version: string,
  ext: string,
): string {
  const safeVersion = version.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeExt = ext.replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `${tenantPath(tenantId)}/${assetId}_${safeVersion}.${safeExt}`;
}

export function extensionForMime(mime: string): string {
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
    'text/csv': 'csv',
    'application/json': 'json',
  };
  return known[mime] ?? 'bin';
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
