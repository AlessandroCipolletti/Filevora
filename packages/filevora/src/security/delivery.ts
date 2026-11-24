import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../errors/error.js';

export interface DeliveryClaims {
  assetId: string;
  /** `original` or a version name such as `thumbnail`. */
  version: string;
  exp: number;
  salt: string;
  download?: string;
  ip?: string;
}

export interface SignedDelivery {
  url: string;
  expiresAt: string;
  token: string;
}

/** HMAC delivery token. The first secret signs. Verification tries every secret. */
export function signDeliveryToken(
  secret: string,
  claims: DeliveryClaims,
): string {
  const payload: Record<string, string | number> = {
    f: claims.assetId,
    n: claims.version,
    exp: claims.exp,
    s: claims.salt,
  };
  if (claims.download) payload.d = claims.download;
  if (claims.ip) payload.ip = claims.ip;
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyDeliveryToken(
  token: string,
  secrets: string[],
  nowMs = Date.now(),
): DeliveryClaims {
  const splitAt = token.lastIndexOf('.');
  if (splitAt <= 0 || secrets.length === 0) {
    throw fail('DELIVERY_MALFORMED', {
      message: 'The delivery token is not a signed payload.',
    });
  }
  const body = token.slice(0, splitAt);
  const mac = token.slice(splitAt + 1);
  const presented = Buffer.from(mac);
  const matched = secrets.some((secret) => {
    const expected = createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    const right = Buffer.from(expected);
    return (
      presented.length === right.length && timingSafeEqual(presented, right)
    );
  });
  if (!matched) {
    throw fail('DELIVERY_BAD_SIGNATURE', {
      message: 'The delivery signature does not match the signing keys.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw fail('DELIVERY_MALFORMED', {
      message: 'The delivery token payload is not JSON.',
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('DELIVERY_MALFORMED', {
      message: 'The delivery token payload is not an object.',
    });
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.f !== 'string' || typeof record.n !== 'string') {
    throw fail('DELIVERY_MALFORMED', {
      message: 'The delivery token is missing the asset or version.',
    });
  }
  if (
    typeof record.exp !== 'number' ||
    !Number.isFinite(record.exp) ||
    record.exp * 1000 < nowMs
  ) {
    throw fail('DELIVERY_EXPIRED', {
      message: 'The delivery URL has expired.',
    });
  }
  const salt = typeof record.s === 'string' ? record.s : '';
  const download = typeof record.d === 'string' ? record.d : undefined;
  const ip = typeof record.ip === 'string' ? record.ip : undefined;
  return {
    assetId: record.f,
    version: record.n,
    exp: record.exp,
    salt,
    ...(download ? { download } : {}),
    ...(ip ? { ip } : {}),
  };
}

export function deliveryExpiry(
  expiresInSeconds: number,
  nowMs = Date.now(),
): number {
  return Math.floor(nowMs / 1000) + expiresInSeconds;
}

export function versionTokenName(version: string): string {
  return version === '_original' ? 'original' : version;
}

export function plainDeliveryPath(assetId: string, version: string): string {
  return `/public/${encodeURIComponent(assetId)}/${encodeURIComponent(versionTokenName(version) === 'original' ? '_original' : version)}`;
}

export function signedDeliveryPath(
  secret: string,
  claims: DeliveryClaims,
): string {
  return `/content/${signDeliveryToken(secret, claims)}`;
}

export function resolveSigningSecrets(config: {
  signingSecrets: string[];
  signingSecret?: string;
  env: string;
}): string[] {
  if (config.signingSecrets.length > 0) return config.signingSecrets;
  if (config.signingSecret) return [config.signingSecret];
  if (config.env !== 'production') return ['filevora-test-signing-secret'];
  return [];
}

export function safeDownloadName(name: string): string {
  const cleaned = name.replace(/["\r\n\\]/g, '').slice(0, 180);
  return cleaned.length > 0 ? cleaned : 'download';
}
