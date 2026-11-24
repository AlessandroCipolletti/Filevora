import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFiles } from 'filevora/server';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const principal = { id: 'user-pack', tenantId: 'tenant-pack' };
const secret = 'signing-key-current-a';

function fail(message) {
  globalThis.console.error(message);
  process.exit(1);
}

const bin = path.join(process.cwd(), 'node_modules', '.bin', 'filevora');
const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || !/\d+\.\d+\.\d+/.test(version.stdout)) {
  fail(version.stderr || 'filevora --version failed');
}
if (version.stderr.includes('ExperimentalWarning')) {
  fail(version.stderr);
}
const workerEnv = { ...process.env };
delete workerEnv.REDIS_URL;
delete workerEnv.FILES_REDIS_URL;
delete workerEnv.FILEVORA_CONFIG_PATH;
const worker = spawnSync(bin, ['worker'], { encoding: 'utf8', env: workerEnv });
if (
  worker.status === 0 ||
  !`${worker.stdout}${worker.stderr}`.includes('REDIS_URL')
) {
  fail(
    `filevora worker should fail without Redis\n${worker.stdout}${worker.stderr}`,
  );
}

const root = mkdtempSync(path.join(tmpdir(), 'filevora-pack-'));
try {
  const lite = createFiles({
    env: 'test',
    storage: { root: path.join(root, 'lite') },
    processing: { mode: 'sync', spawn: 'never' },
    signingSecrets: [secret],
    upload: { chunkBytes: 64 * 1024 },
  });
  try {
    const uploaded = await upload(lite);
    if (uploaded.uploadState !== 'verified')
      fail('lite filesystem upload did not verify');
  } finally {
    await lite.close();
  }

  const stored = createFiles({
    env: 'test',
    storage: { root: path.join(root, 'stored') },
    metadata: { filename: path.join(root, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    signingSecrets: [secret],
    upload: { chunkBytes: 64 * 1024 },
  });
  try {
    const uploaded = await upload(stored);
    if (uploaded.uploadState !== 'verified')
      fail('stored sqlite upload did not verify');
  } finally {
    await stored.close();
  }

  if (process.env.FILEVORA_S3_ENDPOINT) {
    const { CreateBucketCommand, S3Client } =
      await import('@aws-sdk/client-s3');
    const bucket = process.env.FILEVORA_S3_BUCKET || 'filevora-pack';
    const client = new S3Client({
      region: process.env.FILEVORA_S3_REGION || 'us-east-1',
      endpoint: process.env.FILEVORA_S3_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.FILEVORA_S3_ACCESS_KEY_ID || 'local',
        secretAccessKey:
          process.env.FILEVORA_S3_SECRET_ACCESS_KEY || 'localpassword',
      },
    });
    await client
      .send(new CreateBucketCommand({ Bucket: bucket }))
      .catch(() => undefined);
    client.destroy();
    const remote = createFiles({
      env: 'test',
      storage: {
        driver: 's3',
        root: path.join(root, 's3-meta'),
        s3: {
          endpoint: process.env.FILEVORA_S3_ENDPOINT,
          region: process.env.FILEVORA_S3_REGION || 'us-east-1',
          bucket,
          accessKeyId: process.env.FILEVORA_S3_ACCESS_KEY_ID || 'local',
          secretAccessKey:
            process.env.FILEVORA_S3_SECRET_ACCESS_KEY || 'localpassword',
          forcePathStyle: true,
        },
      },
      processing: { mode: 'sync', spawn: 'never' },
      signingSecrets: [secret],
      upload: { chunkBytes: 64 * 1024 },
    });
    try {
      const session = await remote.createUploadSession(
        { filename: 'dot.png', mimeType: 'image/png', bytes: png.length },
        { principal },
      );
      const urls = await remote.partUploadUrls(session.id, { principal });
      const target = urls['1'];
      if (!target) fail('S3 upload did not return a part URL');
      const put = await globalThis.fetch(target, { method: 'PUT', body: png });
      if (!put.ok) fail(`S3 part upload failed ${put.status}`);
      const etag = put.headers.get('etag');
      if (!etag) fail('S3 part upload did not return an etag');
      const uploaded = await remote.completeUpload(
        session.id,
        { parts: [{ partNumber: 1, etag }] },
        { principal },
      );
      if (uploaded.uploadState !== 'verified')
        fail('lite S3 upload did not verify');
    } finally {
      await remote.close();
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

async function upload(files) {
  const session = await files.createUploadSession(
    { filename: 'dot.png', mimeType: 'image/png', bytes: png.length },
    { principal },
  );
  await files.writePart(session.id, 1, png, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

globalThis.console.log('pack smoke ok');
