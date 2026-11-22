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

export function nowIso(): string {
  return new Date().toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}
