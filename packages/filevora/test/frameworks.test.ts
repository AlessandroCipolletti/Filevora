import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilesHandler } from '../dist/http/index.js';
import { createNextHandlers, uploadFormFile } from '../dist/frameworks/next.js';
import { honoHandler } from '../dist/frameworks/hono.js';
import { useAssetProgress, useUpload } from '../dist/frameworks/react.js';
import { createTestFiles, samplePng } from '../dist/testing/index.js';

const options = {
  async authenticate(request: Request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
};

test('Next and Hono handlers serve health without rendering UI', async () => {
  const files = createTestFiles();
  try {
    const handler = createFilesHandler({
      files: files.files,
      health: true,
      ...options,
    });
    const next = createNextHandlers({
      files: files.files,
      health: true,
      ...options,
    });
    const health = await next.GET(new Request('http://app.local/health'));
    assert.equal(health.status === 200 || health.status === 503, true);
    const hono = await honoHandler(handler)({
      req: { raw: new Request('http://app.local/health') },
    });
    assert.equal(hono.status, health.status);
  } finally {
    await files.close();
  }
});

test('a server action helper stores the form file', async () => {
  const harness = createTestFiles();
  try {
    const png = samplePng();
    const form = new FormData();
    form.set('file', new File([png], 'dot.png', { type: 'image/png' }));
    const record = await uploadFormFile(harness.files, form, {
      principal: harness.principal,
    });
    assert.equal(record.detectedMime, 'image/png');
    assert.equal(record.uploadState, 'verified');
  } finally {
    await harness.close();
  }
});

test('React helpers are functions and render nothing', () => {
  assert.equal(typeof useUpload, 'function');
  assert.equal(typeof useAssetProgress, 'function');
  assert.equal(useUpload.length, 1);
  assert.equal(useAssetProgress.length, 2);
});
