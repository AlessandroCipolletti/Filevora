import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from '../errors/error.js';

export function signToken(
  secret: string,
  payload: Record<string, string | number>,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function readToken(
  secret: string,
  token: string,
): Record<string, unknown> | null {
  const splitAt = token.lastIndexOf('.');
  if (splitAt <= 0) return null;
  const body = token.slice(0, splitAt);
  const mac = token.slice(splitAt + 1);
  const expected = createHmac('sha256', secret)
    .update(body)
    .digest('base64url');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8'),
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function assertUnexpired(exp: unknown): void {
  if (
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    exp * 1000 < Date.now()
  ) {
    throw fail('UNAUTHORIZED', {
      message: 'The delivery token is expired or invalid.',
    });
  }
}
