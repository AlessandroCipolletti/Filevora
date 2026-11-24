import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadClient } from '../dist/client/index.js';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { checkRemoteUrl, type RemotePolicy } from '../dist/remote/policy.js';
import { blockReason, decodeIPv4Hostname } from '../dist/remote/address.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const policy: RemotePolicy = {
  maxBytes: 1024 * 1024,
  connectTimeoutMs: 1000,
  timeoutMs: 5000,
  maxRedirects: 2,
  allowedPorts: [80, 443],
  allowPrivate: false,
  allowHosts: [],
  denyHosts: [],
};

function codeOf(error: unknown): string {
  assert.ok(error instanceof FileSdkError);
  return error.code;
}

test('remote URL policy rejects schemes, credentials, ports, and unsafe addresses', async () => {
  assert.equal(decodeIPv4Hostname('2130706433'), '127.0.0.1');
  assert.equal(decodeIPv4Hostname('0x7f000001'), '127.0.0.1');
  assert.equal(decodeIPv4Hostname('0177.0.0.1'), '127.0.0.1');
  assert.equal(decodeIPv4Hostname('127.1'), '127.0.0.1');
  assert.equal(blockReason('127.0.0.1'), 'loopback');
  assert.equal(blockReason('10.0.0.5'), 'private');
  assert.equal(blockReason('192.168.1.20'), 'private');
  assert.equal(blockReason('169.254.169.254'), 'metadata');
  assert.equal(blockReason('::1'), 'loopback');
  assert.equal(blockReason('::ffff:127.0.0.1'), 'loopback');
  assert.equal(blockReason('::ffff:7f00:1'), 'loopback');
  assert.equal(blockReason('224.0.0.1'), 'multicast');
  assert.equal(blockReason('8.8.8.8'), null);

  await assert.rejects(
    () => checkRemoteUrl('file:///etc/passwd', policy),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_SCHEME',
  );
  await assert.rejects(
    () => checkRemoteUrl('http://user:secret@example.com/a', policy),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_CREDENTIALS',
  );
  await assert.rejects(
    () => checkRemoteUrl('http://8.8.8.8:8080/a', policy),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_PORT',
  );
  for (const url of [
    'http://127.0.0.1/a',
    'http://2130706433/a',
    'http://0x7f000001/a',
    'http://0177.0.0.1/a',
    'http://10.0.0.5/a',
    'http://192.168.0.1/a',
    'http://[::1]/a',
    'http://[::ffff:127.0.0.1]/a',
    'http://169.254.169.254/latest',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    await assert.rejects(
      () => checkRemoteUrl(url, policy),
      (error: unknown) => codeOf(error) === 'REMOTE_URL_BLOCKED',
      url,
    );
  }
  await assert.rejects(
    () =>
      checkRemoteUrl(
        'http://10.0.0.5/a',
        { ...policy, allowPrivate: true },
        'redirect',
      ),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_BLOCKED',
  );
  await checkRemoteUrl('http://127.0.0.1/a', { ...policy, allowPrivate: true });
  await assert.rejects(
    () =>
      checkRemoteUrl('http://169.254.169.254/latest', {
        ...policy,
        allowPrivate: true,
      }),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_BLOCKED',
  );
  await assert.rejects(
    () =>
      checkRemoteUrl('http://8.8.8.8/a', {
        ...policy,
        denyHosts: ['8.8.8.8'],
      }),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_HOST',
  );
  await assert.rejects(
    () =>
      checkRemoteUrl('http://1.1.1.1/a', {
        ...policy,
        allowHosts: ['8.8.8.8'],
      }),
    (error: unknown) => codeOf(error) === 'REMOTE_URL_HOST',
  );
  const checked = await checkRemoteUrl('https://1.1.1.1/file.png', policy);
  assert.equal(checked.address, '1.1.1.1');
  assert.equal(checked.port, 443);
});

test('a remote URL becomes an asset and unsafe downloads fail', async () => {
  const server = http.createServer((req, res) => {
    const pathname = req.url ?? '/';
    if (pathname.startsWith('/redirect')) {
      res.writeHead(302, { location: 'http://10.0.0.5/secret' });
      res.end();
      return;
    }
    if (pathname.startsWith('/huge')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(200, 1));
      return;
    }
    if (pathname.startsWith('/text')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('this is not a png file at all');
      return;
    }
    if (pathname.startsWith('/hang')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(PNG.length),
    });
    res.write(PNG.subarray(0, 8));
    setTimeout(() => res.end(PNG.subarray(8)), 120);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-remote-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    processing: { mode: 'inline', spawn: 'never' },
    remote: {
      allowPrivate: true,
      allowedPorts: [port, 80, 443],
      maxBytes: 1024 * 1024,
      connectTimeoutMs: 500,
      timeoutMs: 2000,
      maxRedirects: 2,
    },
  });
  const storedDir = mkdtempSync(path.join(tmpdir(), 'filevora-remote-db-'));
  const stored = createFiles({
    env: 'test',
    storage: { root: path.join(storedDir, 'objects') },
    metadata: { filename: path.join(storedDir, 'host.sqlite') },
    processing: { mode: 'inline', spawn: 'never' },
    remote: {
      allowPrivate: true,
      allowedPorts: [port],
      timeoutMs: 2000,
      connectTimeoutMs: 500,
    },
  });
  try {
    const created = await files.createFromUrl(
      { url: `${base}/dot.png` },
      { principal },
    );
    assert.equal(created.asset?.assetId, created.id);
    assert.equal(created.uploadState, 'uploading');
    const done = await waitFor(files, created.id);
    assert.equal(done.uploadState, 'verified');
    assert.equal(done.detectedMime, 'image/png');
    assert.equal(done.processingState, 'queued');
    assert.ok(
      namesUnder(path.join(dir, 'objects')).some((name) =>
        name.includes('_original.png'),
      ),
    );

    const handler = createFilesHandler({
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
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: (input, init) => handler(new Request(input, init)),
    });
    const viaClient = await client.fromUrl(`${base}/other.png`);
    assert.equal(viaClient.assetId.startsWith('file_'), true);
    await waitFor(files, viaClient.assetId);

    const redirected = await files.createFromUrl(
      { url: `${base}/redirect` },
      { principal },
    );
    const redirectError = await waitFailed(files, redirected.id);
    assert.equal(redirectError, 'REMOTE_URL_BLOCKED');

    const limited = createFiles({
      env: 'test',
      storage: { root: path.join(dir, 'limited') },
      processing: { mode: 'inline', spawn: 'never' },
      remote: {
        allowPrivate: true,
        allowedPorts: [port],
        maxBytes: 32,
        connectTimeoutMs: 500,
        timeoutMs: 2000,
      },
    });
    try {
      const huge = await limited.createFromUrl(
        { url: `${base}/huge` },
        { principal },
      );
      assert.equal(await waitFailed(limited, huge.id), 'FILE_TOO_LARGE');
    } finally {
      await limited.close();
    }

    const text = await files.createFromUrl(
      { url: `${base}/text` },
      { principal },
    );
    assert.equal(await waitFailed(files, text.id), 'UNSUPPORTED_MIME');

    const slow = createFiles({
      env: 'test',
      storage: { root: path.join(dir, 'slow') },
      processing: { mode: 'inline', spawn: 'never' },
      remote: {
        allowPrivate: true,
        allowedPorts: [port],
        connectTimeoutMs: 200,
        timeoutMs: 300,
      },
    });
    try {
      const hanging = await slow.createFromUrl(
        { url: `${base}/hang` },
        { principal },
      );
      assert.equal(await waitFailed(slow, hanging.id), 'REMOTE_URL_TIMEOUT');
    } finally {
      await slow.close();
    }

    const storedFile = await stored.createFromUrl(
      { url: `${base}/dot.png` },
      { principal },
    );
    const storedDone = await waitFor(stored, storedFile.id);
    assert.equal(storedDone.uploadState, 'verified');
    assert.equal(storedDone.metadata.filevoraSource, 'remote-url');
  } finally {
    await files.close();
    await stored.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    rmSync(storedDir, { recursive: true, force: true });
  }
});

async function waitFor(files: ReturnType<typeof createFiles>, id: string) {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const snap = await files.processingSnapshot(id, { principal });
    if (snap.terminal && snap.state === 'failed') {
      throw new Error(snap.errorCode ?? 'download failed');
    }
    const record = await files.get(id, { principal });
    if (record.uploadState === 'verified' && record.processingState !== 'none')
      return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('remote download did not finish');
}

async function waitFailed(files: ReturnType<typeof createFiles>, id: string) {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const snap = await files.processingSnapshot(id, { principal });
    if (snap.terminal && snap.errorCode) return snap.errorCode;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('remote download did not fail');
}

function namesUnder(root: string): string[] {
  const names: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else names.push(entry.name);
    }
  };
  walk(root);
  return names;
}
