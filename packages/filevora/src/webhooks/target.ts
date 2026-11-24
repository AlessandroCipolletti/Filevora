import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { checkRemoteUrl } from '../remote/policy.js';

export interface WebhookRequest {
  url: string;
  secret?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Webhook targets use the same SSRF checks as URL import.
 * Loopback is allowed only when `webhooks.allowLoopback` is set, and then on any port.
 * Every other host keeps the remote port list and the private-address block.
 */
export async function assertWebhookUrl(
  raw: string,
  config: ResolvedConfig,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail('WEBHOOK_REJECTED', {
      message: 'The webhook URL is not a valid URL.',
    });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (LOOPBACK.has(host.toLowerCase())) {
    if (!config.webhooks.allowLoopback) {
      throw fail('WEBHOOK_REJECTED', {
        message:
          'Localhost webhooks require FILES_WEBHOOKS_ALLOW_LOOPBACK=true.',
      });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw fail('REMOTE_URL_SCHEME');
    }
    if (url.username || url.password) throw fail('REMOTE_URL_CREDENTIALS');
    return;
  }
  await checkRemoteUrl(
    raw,
    { ...config.remote, allowPrivate: false },
    'request',
  );
}

export function webhookFields(
  request: WebhookRequest | undefined,
  fallbackSecret: string | undefined,
): Record<string, string> {
  if (!request?.url) return {};
  const secret = request.secret || fallbackSecret;
  return {
    filevoraWebhookUrl: request.url,
    ...(secret ? { filevoraWebhookSecret: secret } : {}),
  };
}
