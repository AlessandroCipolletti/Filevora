import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { runCli } from '../dist/cli/main.js';
import { createUploadClient } from '../dist/client/index.js';
import { redactConfig, resolveConfig } from '../dist/config/load.js';
import { ERROR_CODES } from '../dist/errors/catalog.js';
import { FileSdkError, fail } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';
import { FILEVORA_VERSION } from '../dist/version.js';
import { runWorker } from '../dist/worker/index.js';

const requiredCodes = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'QUOTA_EXCEEDED',
  'FILE_TOO_LARGE',
  'UNSUPPORTED_MIME',
  'MIME_MISMATCH',
  'UPLOAD_SESSION_EXPIRED',
  'UPLOAD_PART_MISSING',
  'CHECKSUM_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'WORKER_NOT_RUNNING',
  'WORKER_UNSUPPORTED_RUNTIME',
  'FFMPEG_NOT_FOUND',
  'FFMPEG_FAILED',
  'PROCESSING_TIMEOUT',
  'PDF_ENCRYPTED',
  'OCR_NOT_CONFIGURED',
  'SCHEMA_VALIDATION_FAILED',
  'RETENTION_POLICY_UNSAFE',
  'FEATURE_NOT_AVAILABLE',
];

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('error catalog covers the public codes and redacts context', () => {
  for (const code of requiredCodes) {
    assert.ok(ERROR_CODES.includes(code as (typeof ERROR_CODES)[number]), code);
    const error = fail(code as (typeof ERROR_CODES)[number]);
    const body = error.toJSON();
    assert.equal(body.code, code);
    assert.equal(typeof body.requestId, 'string');
    assert.equal(body.resolution?.documentationPath, `docs/errors/${code}.md`);
    assert.equal('stack' in body, false);
  }
  const secret = fail('STORAGE_UNAVAILABLE', {
    context: {
      secretAccessKey: 'topsecretvalue',
      note: 'postgres://user:s3cret@localhost/db',
    },
  });
  const json = JSON.stringify(secret.toJSON());
  assert.equal(json.includes('topsecretvalue'), false);
  assert.equal(json.includes('s3cret'), false);
  assert.ok(secret instanceof FileSdkError);
});

test('explicit options override environment and defaults', () => {
  const config = resolveConfig(
    { defaults: { maxFileBytes: 4096 }, storage: { root: './data/objects' } },
    {
      FILES_MAX_FILE_BYTES: '99',
      FILES_STORAGE_ROOT: './from-env',
      FILES_ENV: 'development',
    },
  );
  assert.equal(config.defaults.maxFileBytes, 4096);
  assert.equal(config.storage.root, './data/objects');
  assert.equal(config.defaults.visibility, 'private');
  assert.equal(config.defaults.preserveOriginal, true);
  assert.equal(config.metadata.schema, 'filevora');
});

test('environment overrides defaults when options omit the field', () => {
  const config = resolveConfig(
    {},
    {
      FILES_MAX_FILE_BYTES: '12345',
      FILES_ENV: 'test',
      FILES_RUNTIME: 'long-running',
    },
  );
  assert.equal(config.defaults.maxFileBytes, 12345);
  assert.equal(config.env, 'test');
});

test('redacted config removes signing secrets, cloud keys, and database passwords', () => {
  const config = resolveConfig(
    {
      env: 'development',
      signingSecret: 'signing-secret-value',
      storage: {
        driver: 's3',
        s3: {
          bucket: 'bucket-a',
          region: 'eu-west-1',
          secretAccessKey: 'topsecretvalue',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        },
      },
      metadata: {
        driver: 'postgres',
        url: 'postgresql://user:s3cret@localhost:5432/app',
      },
      cloud: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz' },
    },
    { FILES_RUNTIME: 'long-running' },
  );
  const json = JSON.stringify(redactConfig(config));
  assert.equal(json.includes('signing-secret-value'), false);
  assert.equal(json.includes('topsecretvalue'), false);
  assert.equal(json.includes('s3cret'), false);
  assert.equal(json.includes('sk-live-abcdefghijklmnopqrstuvwxyz'), false);
  assert.equal(json.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(json.includes('bucket-a'), true);
  assert.equal(config.provider, 'embedded');
});

test('managed, hybrid, and cloud processing are rejected', () => {
  assert.throws(
    () => resolveConfig({ provider: 'managed' }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FEATURE_NOT_AVAILABLE');
      return true;
    },
  );
  assert.throws(
    () => resolveConfig({ provider: 'hybrid' }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FEATURE_NOT_AVAILABLE');
      return true;
    },
  );
  assert.throws(
    () => resolveConfig({ storage: { driver: 'managed' } }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FEATURE_NOT_AVAILABLE');
      return true;
    },
  );
  assert.throws(
    () => resolveConfig({ processing: { mode: 'cloud' } }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'FEATURE_NOT_AVAILABLE');
      return true;
    },
  );
});

test('production rejects unacknowledged local storage and ephemeral roots', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          env: 'production',
          storage: { driver: 'filesystem', root: '/var/lib/filevora' },
          metadata: {
            driver: 'sqlite',
            filename: '/var/lib/filevora/meta.sqlite',
          },
        },
        { FILES_RUNTIME: 'long-running' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'UNSAFE_PRODUCTION_CONFIG');
      return true;
    },
  );
  assert.throws(
    () =>
      resolveConfig(
        {
          env: 'production',
          singleHostAcknowledged: true,
          storage: { driver: 'filesystem', root: tmpdir() },
        },
        { FILES_RUNTIME: 'long-running' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'UNSAFE_PRODUCTION_CONFIG');
      return true;
    },
  );
});

test('serverless auto-spawn is rejected and distributed metadata mode is allowed', () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          env: 'production',
          storage: { driver: 's3', s3: { bucket: 'b', region: 'us-east-1' } },
          metadata: {
            driver: 'postgres',
            url: 'postgresql://user:pass@db:5432/app',
          },
        },
        { AWS_LAMBDA_FUNCTION_NAME: 'fn' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'WORKER_UNSUPPORTED_RUNTIME');
      return true;
    },
  );
  const config = resolveConfig(
    {
      env: 'production',
      provider: 'distributed',
      runtime: 'serverless',
      storage: { driver: 's3', s3: { bucket: 'b', region: 'eu-west-1' } },
      metadata: {
        driver: 'postgres',
        url: 'postgresql://user:pass@db:5432/app',
      },
      processing: { mode: 'distributed', spawn: 'never' },
    },
    {},
  );
  assert.equal(config.provider, 'distributed');
  assert.equal(config.processing.spawn, 'never');
  assert.equal(config.runtime, 'serverless');
});

test('createFiles validates config and does not create storage or spawn a worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m0-'));
  const root = path.join(dir, 'objects');
  try {
    const files = createFiles({
      env: 'test',
      storage: { root },
      metadata: { filename: path.join(dir, 'meta.sqlite') },
    });
    assert.equal(files.config.env, 'test');
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(path.join(dir, 'meta.sqlite')), false);
    await files.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handler and worker fail closed until their milestones', async () => {
  const files = createFiles({ env: 'test' });
  assert.throws(() =>
    createFilesHandler({
      files,
      authenticate: async () => null,
      authorize: async () => false,
      policy: undefined as unknown as (input: {
        principal: { id: string; tenantId: string };
        request: Request;
      }) => Promise<Record<string, never>>,
    }),
  );
  const handler = createFilesHandler({
    files,
    authenticate: async () => ({ id: 'user', tenantId: 'tenant' }),
    authorize: async () => true,
    policy: async () => ({}),
  });
  assert.equal(typeof handler, 'function');
  const savedRedis = process.env.REDIS_URL;
  const savedAlias = process.env.FILES_REDIS_URL;
  delete process.env.REDIS_URL;
  delete process.env.FILES_REDIS_URL;
  try {
    await assert.rejects(
      runWorker({ options: { env: 'development' } }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'INVALID_CONFIG');
        return true;
      },
    );
  } finally {
    if (savedRedis) process.env.REDIS_URL = savedRedis;
    if (savedAlias) process.env.FILES_REDIS_URL = savedAlias;
  }
  assert.throws(
    () => createUploadClient({ endpoint: '' }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'INVALID_CONFIG');
      return true;
    },
  );
  const client = createUploadClient({ endpoint: '/api/files' });
  assert.equal(typeof client.upload, 'function');
  await files.close();
});

test('browser bundle of the client entry does not contain Node built-ins', async () => {
  const forbidden =
    /from ["']node:|require\(["']node:|node:fs|node:sqlite|node:child_process|from ["']sharp|from ["']@aws-sdk|from ["']pg["']/;
  for (const entry of ['src/client/index.ts', 'dist/client/index.js']) {
    const result = await esbuild.build({
      absWorkingDir: packageRoot,
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
    });
    const text = result.outputFiles[0]?.text ?? '';
    assert.equal(text.length > 0, true, entry);
    assert.doesNotMatch(text, forbidden, entry);
  }
});

test('capabilities manifest matches the schema and does not mark untested features as tested', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, 'capabilities.json'), 'utf8'),
  ) as {
    version: string;
    needsAccount: boolean;
    features: Record<string, string>;
    billing: string;
    accounts: string;
    hostedControlPlane: string;
    managedProvider: string;
  };
  const docsCopy = readFileSync(
    path.join(repoRoot, 'docs/agents/capabilities.json'),
    'utf8',
  );
  assert.equal(
    docsCopy,
    readFileSync(path.join(packageRoot, 'capabilities.json'), 'utf8'),
  );
  const schema = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'docs/agents/capabilities.schema.json'),
      'utf8',
    ),
  ) as {
    required: string[];
  };
  for (const key of schema.required) assert.ok(key in manifest, key);
  assert.equal(manifest.version, FILEVORA_VERSION);
  assert.equal(manifest.needsAccount, false);
  assert.equal(manifest.billing, 'unsupported');
  assert.equal(manifest.accounts, 'unsupported');
  assert.equal(manifest.hostedControlPlane, 'unsupported');
  assert.equal(manifest.managedProvider, 'unsupported');
  const testedNow = new Set([
    'configValidation',
    'errorCatalog',
    'browserServerSplit',
    'managedProviderRejected',
    'filesystemStorage',
    'sqliteMetadata',
    'httpUpload',
    'resumableUpload',
    'durableQueue',
    'embeddedWorker',
    'doctor',
    'imageProcessing',
    'videoProcessing',
    'audioProcessing',
    's3Storage',
    'postgresMetadata',
    'pdfExtraction',
    'tabularNormalization',
    'retention',
    'webhooks',
    'aiDiagnostics',
    'uploadProgress',
    'processingProgress',
    'uploadHistory',
    'metadataModes',
    'namedPresets',
  ]);
  for (const [id, status] of Object.entries(manifest.features)) {
    if (status === 'tested')
      assert.ok(
        testedNow.has(id),
        `${id} is marked tested without an allowlist entry`,
      );
  }
  for (const id of testedNow) assert.equal(manifest.features[id], 'tested');
});

test('CLI capabilities and config validate return JSON', async () => {
  const lines: string[] = [];
  const code = await runCli(
    ['capabilities', '--json'],
    {},
    { stdout: (line) => lines.push(line), stderr: () => undefined },
  );
  assert.equal(code, 0);
  const manifest = JSON.parse(lines.join('')) as { package: string };
  assert.equal(manifest.package, 'filevora');

  const okLines: string[] = [];
  const ok = await runCli(
    ['config', 'validate', '--json'],
    { FILES_ENV: 'test', FILES_RUNTIME: 'long-running' },
    {
      stdout: (line) => okLines.push(line),
      stderr: () => undefined,
    },
  );
  assert.equal(ok, 0);
  const parsed = JSON.parse(okLines.join('')) as {
    ok: boolean;
    config: { signingSecret?: string };
  };
  assert.equal(parsed.ok, true);

  const badLines: string[] = [];
  const bad = await runCli(
    ['config', 'validate', '--json'],
    { FILES_PROVIDER: 'managed' },
    {
      stdout: (line) => badLines.push(line),
      stderr: () => undefined,
    },
  );
  assert.equal(bad, 1);
  const failure = JSON.parse(badLines.join('')) as {
    ok: boolean;
    error: { code: string };
  };
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, 'FEATURE_NOT_AVAILABLE');
});

test('fixture app can import the built package', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(repoRoot, 'examples/fixture-app/src/run.ts'),
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /provider=embedded/);
});

test('every catalog code has a markdown note', () => {
  for (const code of ERROR_CODES) {
    assert.equal(
      existsSync(path.join(repoRoot, 'docs/errors', `${code}.md`)),
      true,
      code,
    );
  }
});

test('package version matches package.json', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { version: string; name: string };
  assert.equal(pkg.name, 'filevora');
  assert.equal(pkg.version, FILEVORA_VERSION);
});
