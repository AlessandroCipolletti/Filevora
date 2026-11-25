import { createHash } from 'node:crypto';
import { fail } from '../errors/error.js';

export interface SearchCursorPayload {
  v: 1;
  /** Quantized score of the last item on the previous page. */
  s: number;
  /** Asset id of the last item on the previous page. */
  id: string;
  /** Results already returned on earlier pages. */
  n: number;
  /** Fingerprint of the query, model, and filters this cursor belongs to. */
  qh: string;
}

export const CURSOR_MISMATCH_MESSAGE =
  'The search cursor does not match the current query or filters. Keep query, minScore, maxResults, and all filters unchanged when passing nextCursor, or omit cursor to start from the first page.';

export function scoreToMicros(raw: number): number {
  return Math.max(-1_000_000, Math.min(1_000_000, Math.round(raw * 1_000_000)));
}

export function microsToScore(micros: number): number {
  return micros / 1_000_000;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

export function queryFingerprint(parts: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(parts)))
    .digest('hex')
    .slice(0, 16);
}

export function encodeSearchCursor(payload: SearchCursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSearchCursor(
  cursor: string,
  fingerprint: string,
): SearchCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw fail('SEARCH_QUERY_INVALID', { message: CURSOR_MISMATCH_MESSAGE });
  }
  const payload = parsed as Partial<SearchCursorPayload> | null;
  if (
    !payload ||
    payload.v !== 1 ||
    !Number.isInteger(payload.s) ||
    typeof payload.id !== 'string' ||
    !Number.isInteger(payload.n) ||
    (payload.n ?? 0) < 0 ||
    payload.qh !== fingerprint
  ) {
    throw fail('SEARCH_QUERY_INVALID', { message: CURSOR_MISMATCH_MESSAGE });
  }
  return payload as SearchCursorPayload;
}
