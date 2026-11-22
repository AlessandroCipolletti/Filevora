import { createHmac, timingSafeEqual } from 'node:crypto';
import { type FileSdkError, fail } from '../errors/error.js';
import { redactValue } from '../redact.js';

export interface Explanation {
  suggestion: string;
}

export interface Explainer {
  explain(report: Record<string, unknown>): Promise<Explanation | null>;
}

/**
 * Ask an optional explainer for a suggestion. The returned code is always the
 * original error code. A failing explainer leaves the error unchanged.
 */
export async function explainError(
  error: FileSdkError,
  explainer?: Explainer,
): Promise<Record<string, unknown>> {
  const report = redactValue(error.toJSON()) as Record<string, unknown>;
  let suggestion: string | undefined;
  if (explainer) {
    try {
      const extra = await explainer.explain(report);
      suggestion = extra?.suggestion;
    } catch {
      suggestion = undefined;
    }
  }
  return { ...report, code: error.code, ...(suggestion ? { suggestion } : {}) };
}

export function signWebhook(
  secret: string,
  body: string,
  timestamp: number,
): string {
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhook(
  secret: string,
  body: string,
  header: string,
  nowSeconds: number,
  windowSeconds = 300,
): boolean {
  const timestamp = Number(/t=(\d+)/.exec(header)?.[1]);
  const mac = /v1=([a-f0-9]+)/.exec(header)?.[1];
  if (!timestamp || !mac || Math.abs(nowSeconds - timestamp) > windowSeconds)
    return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function assertWebhookTarget(url: string, allowLoopback: boolean): void {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const privateAddress =
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.startsWith('172.16.');
  if (
    parsed.protocol !== 'https:' &&
    !(allowLoopback && parsed.protocol === 'http:' && loopback)
  ) {
    throw fail('WEBHOOK_REJECTED');
  }
  if ((loopback || privateAddress) && !allowLoopback)
    throw fail('WEBHOOK_REJECTED');
}
