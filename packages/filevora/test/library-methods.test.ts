import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFilesHandler } from '../dist/http/index.js';
import {
  createFiles,
  explainError,
  redactConfig,
  verifyWebhookSignature,
  type ProgressEvent,
} from '../dist/server/index.js';
import { fail, FileSdkError } from '../dist/errors/error.js';
import {
  createTestFiles,
  samplePng,
  uploadBytes,
} from '../dist/testing/index.js';
import type { Visibility } from '../dist/types/index.js';

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

test('getMany returns assets in order, skips missing ids, and caps lite at 20', async () => {
  const harness = createTestFiles();
  const ctx = { principal: harness.principal };
  try {
    const first = await uploadBytes(harness, samplePng(), 'a.png', 'image/png');
    const second = await uploadBytes(
      harness,
      samplePng(),
      'b.png',
      'image/png',
    );
    const assets = await harness.files.getMany(
      [second.id, 'file_missing', first.id],
      ctx,
    );
    assert.deepEqual(
      assets.map((asset) => asset.id),
      [second.id, first.id],
    );
    assert.equal(assets[0]?.asset?.assetId, second.id);
    await assert.rejects(
      harness.files.getMany(
        Array.from({ length: 21 }, (_, index) => `file_${index}`),
        ctx,
      ),
      (error) => codeOf(error) === 'FEATURE_REQUIRES_STORED_MODE',
    );
    const handler = createFilesHandler({
      files: harness.files,
      authenticate: async () => harness.principal,
      authorize: async () => true,
      policy: async () => ({}),
    });
    const response = await handler(
      new Request('http://files.test/files/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assetIds: [second.id, 'file_missing'] }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { assets: Array<{ id: string }> };
    assert.deepEqual(
      body.assets.map((asset) => asset.id),
      [second.id],
    );
  } finally {
    await harness.close();
  }
});

test('watchProgress yields the terminal event with version URLs', async () => {
  const harness = createTestFiles();
  const ctx = { principal: harness.principal };
  try {
    const file = await uploadBytes(harness, samplePng(), 'a.png', 'image/png');
    const events: ProgressEvent[] = [];
    for await (const event of harness.files.watchProgress(file.id, ctx, {
      baseUrl: 'http://files.test',
    })) {
      events.push(event);
    }
    assert.equal(events.length, 1);
    assert.equal(events[0]?.terminal, true);
    assert.ok(
      events[0]?.versions?._original?.url?.startsWith('http://files.test/'),
    );
    const stop = new AbortController();
    stop.abort();
    const stopped: ProgressEvent[] = [];
    for await (const event of harness.files.watchProgress(file.id, ctx, {
      signal: stop.signal,
    })) {
      stopped.push(event);
    }
    assert.equal(stopped.length, 0);
    await assert.rejects(
      async () => {
        for await (const event of harness.files.watchProgress(
          'file_missing',
          ctx,
        )) {
          assert.fail(`unexpected event ${event.state}`);
        }
      },
      (error) => codeOf(error) === 'ASSET_NOT_FOUND',
    );
  } finally {
    await harness.close();
  }
});

test('createUploadSession applies ctx.policy and rejects missing fields', async () => {
  const harness = createTestFiles();
  const principal = harness.principal;
  try {
    await assert.rejects(
      harness.files.createUploadSession(
        { filename: 'a.png', mimeType: 'image/png', bytes: 200 },
        { principal, policy: { maxFileBytes: 100 } },
      ),
      (error) => codeOf(error) === 'FILE_TOO_LARGE',
    );
    await assert.rejects(
      harness.files.createUploadSession(
        { filename: 'a.png', mimeType: 'image/png', bytes: 10 },
        { principal, policy: { allowedMimeTypes: ['application/pdf'] } },
      ),
      (error) => codeOf(error) === 'UNSUPPORTED_MIME',
    );
    await assert.rejects(
      harness.files.createUploadSession(
        { filename: '', mimeType: 'image/png', bytes: 10 },
        { principal },
      ),
      (error) =>
        error instanceof FileSdkError &&
        error.code === 'INVALID_CONFIG' &&
        error.message === 'filename, mimeType, and bytes are required.',
    );
    const png = samplePng();
    const session = await harness.files.createUploadSession(
      { filename: 'a.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal, policy: { ownerId: 'owner-from-policy' } },
    );
    await harness.files.writePart(session.id, 1, png, { principal });
    const file = await harness.files.completeUpload(
      session.id,
      {},
      { principal },
    );
    assert.equal(file.ownerId, 'owner-from-policy');
  } finally {
    await harness.close();
  }
});

test('createFromUrl, createDirectUpload, and setVisibility validate like HTTP', async () => {
  const harness = createTestFiles();
  const ctx = { principal: harness.principal };
  try {
    await assert.rejects(
      harness.files.createFromUrl({ url: '' }, ctx),
      (error) =>
        error instanceof FileSdkError &&
        error.code === 'INVALID_CONFIG' &&
        error.message === 'url is required.',
    );
    await assert.rejects(
      harness.files.createDirectUpload(
        { filename: 'a.png', mimeType: '', bytes: 10 },
        ctx,
      ),
      (error) =>
        error instanceof FileSdkError &&
        error.message === 'filename, mimeType, and bytes are required.',
    );
    const file = await uploadBytes(harness, samplePng(), 'a.png', 'image/png');
    await assert.rejects(
      harness.files.setVisibility(file.id, 'shared' as Visibility, ctx),
      (error) =>
        error instanceof FileSdkError &&
        error.code === 'INVALID_CONFIG' &&
        error.message === 'visibility must be public or private.',
    );
    assert.equal((await harness.files.get(file.id, ctx)).visibility, 'private');
  } finally {
    await harness.close();
  }
});

test('doctor, migrate, and listPresets run in process', async () => {
  const harness = createTestFiles({
    presets: {
      'square-200': {
        family: 'image',
        operations: [
          { op: 'image.resize', width: 200, height: 200, fit: 'cover' },
        ],
      },
    },
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-library-'));
  const stored = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { mode: 'stored', url: `sqlite://${path.join(dir, 'h.sqlite')}` },
    processing: { mode: 'inline', spawn: 'never' },
  });
  try {
    const report = await harness.files.doctor();
    assert.equal(typeof report.ok, 'boolean');
    assert.ok(report.checks.some((check) => check.id === 'node'));
    await assert.rejects(
      harness.files.migrate(),
      (error) => codeOf(error) === 'FEATURE_REQUIRES_STORED_MODE',
    );
    assert.deepEqual(await stored.migrate(), { ok: true, mode: 'stored' });
    const names = harness.files.listPresets().map((preset) => preset.name);
    assert.ok(names.includes('thumbnail'));
    assert.ok(names.includes('square-200'));
  } finally {
    await harness.close();
    await stored.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyWebhookSignature accepts the delivered headers and rejects tampering', () => {
  const secret = 'whsec-test';
  const body = JSON.stringify({ assetId: 'file_1', terminal: true });
  const timestamp = '1800000000';
  const mac = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const base = { secret, body, timestamp, nowSeconds: 1_800_000_010 };
  assert.equal(
    verifyWebhookSignature({ ...base, signature: `sha256=${mac}` }),
    true,
  );
  assert.equal(verifyWebhookSignature({ ...base, signature: mac }), true);
  assert.equal(
    verifyWebhookSignature({
      ...base,
      body: `${body} `,
      signature: `sha256=${mac}`,
    }),
    false,
  );
  assert.equal(
    verifyWebhookSignature({
      ...base,
      nowSeconds: 1_800_001_000,
      signature: `sha256=${mac}`,
    }),
    false,
  );
  assert.equal(verifyWebhookSignature({ ...base, signature: null }), false);
});

test('explainError and redactConfig are exported from filevora/server', async () => {
  const harness = createTestFiles({ signingSecret: 'super-secret-value' });
  try {
    const redacted = JSON.stringify(redactConfig(harness.files.config));
    assert.equal(redacted.includes('super-secret-value'), false);
    const error = fail('ASSET_NOT_FOUND');
    const explained = await explainError(error, {
      explain: async () => ({ suggestion: 'Check the id.' }),
    });
    assert.equal(explained.code, 'ASSET_NOT_FOUND');
    assert.equal(explained.suggestion, 'Check the id.');
  } finally {
    await harness.close();
  }
});
