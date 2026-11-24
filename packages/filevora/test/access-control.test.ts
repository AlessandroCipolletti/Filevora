import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadClient } from '../dist/client/index.js';
import { createFilesHandler } from '../dist/http/index.js';
import {
  signDeliveryToken,
  verifyDeliveryToken,
} from '../dist/server/index.js';
import { createFiles } from '../dist/server/index.js';
import { startS3Emulator } from '../dist/storage/s3-emulator.js';
import {
  createTestFiles,
  samplePng,
  signTestDeliveryUrl,
} from '../dist/testing/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const KEY_A = 'signing-key-current-a';
const KEY_B = 'signing-key-previous-b';

test('verifyDeliveryToken reports expiry, tampering, and key rotation', () => {
  const claims = {
    assetId: 'file_1',
    version: 'original',
    exp: Math.floor(Date.now() / 1000) + 60,
    salt: 'salt-a',
  };
  const current = signDeliveryToken(KEY_A, claims);
  assert.equal(verifyDeliveryToken(current, [KEY_A, KEY_B]).assetId, 'file_1');
  const previous = signDeliveryToken(KEY_B, claims);
  assert.equal(verifyDeliveryToken(previous, [KEY_A, KEY_B]).salt, 'salt-a');
  assert.throws(
    () => verifyDeliveryToken(previous, [KEY_A]),
    (error: { code?: string }) => error.code === 'DELIVERY_BAD_SIGNATURE',
  );
  const [body, mac] = current.split('.');
  assert.throws(
    () => verifyDeliveryToken(`${body}.${mac?.slice(0, -1)}x`, [KEY_A]),
    (error: { code?: string }) => error.code === 'DELIVERY_BAD_SIGNATURE',
  );
  assert.throws(
    () => verifyDeliveryToken('not-a-token', [KEY_A]),
    (error: { code?: string }) => error.code === 'DELIVERY_MALFORMED',
  );
  const expired = signDeliveryToken(KEY_A, { ...claims, exp: 1 });
  assert.throws(
    () => verifyDeliveryToken(expired, [KEY_A]),
    (error: { code?: string }) => error.code === 'DELIVERY_EXPIRED',
  );
  assert.equal(
    signTestDeliveryUrl('file_1', { salt: 'salt-a' }).includes('/content/'),
    true,
  );
});

test('lite mode signs private URLs and serves public URLs without a signature', async () => {
  const harness = createTestFiles({
    defaults: { allowPublicFiles: true },
    signingSecrets: [KEY_A, KEY_B],
  });
  const handler = handlerFor(harness.files);
  try {
    const png = samplePng();
    const session = await harness.files.createUploadSession(
      {
        filename: 'dot.png',
        mimeType: 'image/png',
        bytes: png.byteLength,
        preset: 'thumbnail',
      },
      { principal },
    );
    await harness.files.writePart(session.id, 1, png, { principal });
    const uploaded = await harness.files.completeUpload(
      session.id,
      {},
      { principal },
    );
    const progress = await harness.files.processingSnapshot(
      uploaded.id,
      { principal },
      { baseUrl: 'http://app.local' },
    );
    assert.match(progress.versions?._original?.url ?? '', /\/content\//);
    assert.match(progress.versions?.thumbnail?.url ?? '', /\/content\//);

    const signed = await harness.files.signUrl(
      uploaded.id,
      {
        version: '_original',
        expiresIn: 60,
        download: 'dot.png',
        baseUrl: 'http://app.local',
      },
      { principal },
    );
    const ok = await handler(new Request(signed.url));
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-disposition') ?? '', /dot\.png/);
    const card = readdirSync(
      path.join(harness.root, '.filevora', 'files'),
    ).find((name) => name.endsWith('.json'));
    assert.ok(card);

    const blocked = await handler(
      new Request(`http://app.local/public/${uploaded.id}/_original`),
    );
    const blockedBody = (await blocked.json()) as { code: string };
    assert.equal(blocked.status, 403);
    assert.equal(blockedBody.code, 'DELIVERY_PRIVATE');

    const tampered = signed.url.replace(/.$/, (char) =>
      char === 'a' ? 'b' : 'a',
    );
    const bad = await handler(new Request(tampered));
    assert.equal(
      ((await bad.json()) as { code: string }).code,
      'DELIVERY_BAD_SIGNATURE',
    );

    const token = signed.url.split('/content/')[1] ?? '';
    const payload = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { f: string; n: string; s: string };
    const expired = signDeliveryToken(KEY_A, {
      assetId: payload.f,
      version: payload.n,
      exp: 1,
      salt: payload.s,
    });
    const old = await handler(
      new Request(`http://app.local/content/${expired}`),
    );
    assert.equal(
      ((await old.json()) as { code: string }).code,
      'DELIVERY_EXPIRED',
    );

    const previous = signDeliveryToken(KEY_B, {
      assetId: payload.f,
      version: payload.n,
      exp: Math.floor(Date.now() / 1000) + 60,
      salt: payload.s,
    });
    assert.equal(
      (await handler(new Request(`http://app.local/content/${previous}`)))
        .status,
      200,
    );

    const bound = await harness.files.signUrl(
      uploaded.id,
      { ip: '203.0.113.8', baseUrl: 'http://app.local' },
      { principal },
    );
    const wrongIp = await handler(new Request(bound.url));
    assert.equal(
      ((await wrongIp.json()) as { code: string }).code,
      'DELIVERY_IP_DENIED',
    );
    const rightIp = await handler(
      new Request(bound.url, { headers: { 'x-forwarded-for': '203.0.113.8' } }),
    );
    assert.equal(rightIp.status, 200);

    await harness.files.revokeUrls(uploaded.id, { principal });
    const revoked = await handler(new Request(signed.url));
    assert.equal(
      ((await revoked.json()) as { code: string }).code,
      'DELIVERY_REVOKED',
    );

    await harness.files.setVisibility(uploaded.id, 'public', { principal });
    const published = await handler(
      new Request(`http://app.local/public/${uploaded.id}/_original`),
    );
    assert.equal(published.status, 200);
    const again = await harness.files.processingSnapshot(
      uploaded.id,
      { principal },
      { baseUrl: 'http://app.local' },
    );
    assert.match(again.versions?._original?.url ?? '', /\/public\//);
  } finally {
    await harness.close();
  }
});

test('stored mode keeps visibility and the url salt on filevora_assets', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-access-stored-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
    defaults: { allowPublicFiles: true },
    signingSecrets: [KEY_A],
  });
  const handler = handlerFor(files);
  try {
    const png = samplePng();
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, png, { principal });
    const uploaded = await files.completeUpload(session.id, {}, { principal });
    assert.equal(uploaded.visibility, 'private');
    const signed = await files.signUrl(
      uploaded.id,
      { baseUrl: 'http://app.local' },
      { principal },
    );
    assert.equal((await handler(new Request(signed.url))).status, 200);
    await files.setVisibility(uploaded.id, 'public', { principal });
    assert.equal(
      (await files.get(uploaded.id, { principal })).visibility,
      'public',
    );
    assert.equal(
      (
        await handler(
          new Request(`http://app.local/public/${uploaded.id}/_original`),
        )
      ).status,
      200,
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('private S3 originals are presigned and a bare object URL is refused', async () => {
  const emulator = await startS3Emulator({
    bucket: 'uploads',
    secret: 'localpassword',
  });
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-access-s3-'));
  const files = createFiles({
    env: 'test',
    storage: {
      driver: 's3',
      root: dir,
      s3: {
        endpoint: emulator.url,
        region: 'us-east-1',
        bucket: 'uploads',
        accessKeyId: 'local',
        secretAccessKey: 'localpassword',
        forcePathStyle: true,
      },
    },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    signingSecrets: [KEY_A],
  });
  try {
    const png = samplePng();
    const handler = handlerFor(files);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(emulator.url)) return fetch(input, init);
      return handler(new Request(input, init));
    };
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: fetchImpl,
      headers: { 'x-user': 'user-a', 'x-tenant': 'tenant-a' },
      resumeStore: {
        async get() {
          return undefined;
        },
        async set() {},
        async delete() {},
      },
    });
    const uploaded = await client
      .upload(new File([png], 'dot.png', { type: 'image/png' }), {
        resume: { enabled: false },
      })
      .complete();
    const delivery = await files.getDeliveryUrls(
      uploaded.id,
      { baseUrl: 'http://app.local', expiresInSeconds: 900 },
      { principal },
    );
    const url = delivery.original?.url ?? '';
    assert.equal(url.startsWith(emulator.url), true);
    assert.equal(url.toLowerCase().includes('x-amz-signature'), true);
    assert.equal(url.includes('localpassword'), false);
    const bare = new URL(url);
    bare.search = '';
    const direct = await fetch(bare);
    assert.equal(direct.status, 403);
    const fetched = await fetch(url);
    assert.equal(fetched.status, 200);
  } finally {
    await files.close();
    await emulator.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function handlerFor(files: ReturnType<typeof createTestFiles>['files']) {
  return createFilesHandler({
    files,
    async authenticate() {
      return principal;
    },
    async authorize() {
      return true;
    },
    async policy() {
      return {};
    },
  });
}
