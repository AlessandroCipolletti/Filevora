import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FileSdkError } from '../dist/errors/error.js';
import { createFiles } from '../dist/server/index.js';
import { samplePng } from '../dist/testing/index.js';
import { runWorker } from '../dist/worker/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const secret = 'webhook-secret';

function signature(timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

async function listen(): Promise<{
  url: string;
  events: Array<{ event: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}> {
  const events: Array<{ event: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const timestamp = request.headers['x-filevora-timestamp'];
    const header = request.headers['x-filevora-signature'];
    assert.equal(typeof timestamp, 'string');
    assert.equal(header, `sha256=${signature(String(timestamp), body)}`);
    events.push({
      event: String(request.headers['x-filevora-event']),
      body: JSON.parse(body) as Record<string, unknown>,
    });
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    events,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

test('webhook targets use the URL import blocks and allow localhost only by opt-in', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-hook-policy-'));
  const blocked = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    webhooks: { allowLoopback: false, url: 'http://127.0.0.1:9/hook', secret },
  });
  try {
    await assert.rejects(
      blocked.createUploadSession(
        { filename: 'a.png', mimeType: 'image/png', bytes: 8 },
        { principal },
      ),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'WEBHOOK_REJECTED',
    );
  } finally {
    await blocked.close();
  }
  const remote = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects-2') },
    webhooks: {
      allowLoopback: true,
      url: 'http://10.1.2.3/hook',
      secret,
    },
  });
  try {
    await assert.rejects(
      remote.createUploadSession(
        { filename: 'a.png', mimeType: 'image/png', bytes: 8 },
        { principal },
      ),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'REMOTE_URL_BLOCKED',
    );
  } finally {
    await remote.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completion webhooks send the signed progress payload', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-hook-'));
  const hook = await listen();
  const options = {
    env: 'test' as const,
    storage: { root: path.join(dir, 'objects') },
    signingSecret: 'signing-secret-value',
    publicBaseUrl: 'http://files.test',
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline' as const, spawn: 'never' as const },
    webhooks: { allowLoopback: true, url: hook.url, secret },
  };
  const files = createFiles(options);
  try {
    const png = samplePng();
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, png, { principal });
    const saved = await files.completeUpload(session.id, {}, { principal });
    assert.equal(saved.metadata.filevoraWebhookSecret, undefined);
    for (let attempt = 0; attempt < 6 && hook.events.length < 2; attempt += 1) {
      await runWorker({ once: true, options });
    }
    const names = hook.events.map((event) => event.event);
    assert.ok(names.includes('upload.completed'));
    assert.ok(names.includes('processing.completed'));
    const done = hook.events.find(
      (event) => event.event === 'processing.completed',
    );
    const versions = done?.body.versions as
      Record<string, { url?: string }> | undefined;
    assert.equal(done?.body.assetId, saved.id);
    assert.equal(typeof versions?._original?.url, 'string');
    assert.equal(typeof versions?.thumbnail?.url, 'string');
  } finally {
    await files.close();
    await hook.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
