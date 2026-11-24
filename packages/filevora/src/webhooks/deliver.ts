import { createHmac } from 'node:crypto';
import type { ResolvedConfig } from '../config/load.js';
import { createId } from '../ids.js';
import { enqueueProcessingJob } from '../queue/processing-queue.js';
import { assertWebhookUrl } from './target.js';

export type WebhookEventName =
  | 'upload.completed'
  | 'processing.completed'
  | 'processing.failed'
  | 'transform.completed';

export function webhookSignature(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/** Queue one signed POST. BullMQ retries with the queue backoff. */
export async function enqueueWebhookJob(input: {
  config: ResolvedConfig;
  fileId: string;
  tenantId: string;
  event: WebhookEventName;
  url: string;
  secret: string;
  body: string;
}): Promise<void> {
  await assertWebhookUrl(input.url, input.config);
  await enqueueProcessingJob({
    env: input.config.env,
    redisUrl: input.config.queue.redisUrl,
    id: `wh_${createId('job')}`,
    fileId: input.fileId,
    tenantId: input.tenantId,
    type: 'webhook',
    payload: {
      url: input.url,
      secret: input.secret,
      event: input.event,
      body: input.body,
    },
    maxAttempts: input.config.queue.maxAttempts,
    backoffMs: input.config.queue.backoffBaseMs,
    scope: input.config.storage.root,
  });
}

/**
 * POST the progress JSON. 5xx and network errors throw so BullMQ retries.
 * 4xx does not retry.
 */
export async function postWebhook(input: {
  url: string;
  secret: string;
  event: string;
  body: string;
  config: ResolvedConfig;
}): Promise<void> {
  await assertWebhookUrl(input.url, input.config);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(input.url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      'x-filevora-event': input.event,
      'x-filevora-timestamp': timestamp,
      'x-filevora-signature': `sha256=${webhookSignature(input.secret, timestamp, input.body)}`,
    },
    body: input.body,
  });
  if (
    response.status >= 300 &&
    response.status < 500 &&
    response.status !== 429
  ) {
    const error = new Error(`Webhook returned ${response.status}.`);
    error.name = 'UnrecoverableError';
    throw error;
  }
  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}.`);
  }
}
