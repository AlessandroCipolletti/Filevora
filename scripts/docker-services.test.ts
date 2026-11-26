import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  describeDockerProblem,
  parseRedisUrl,
  redisPreflight,
  repoRoot,
} from './docker-services.ts';
import { COMPOSE_FILE, SERVICE_PORTS, TEST_ENV, testEnv } from './test-env.ts';

const compose = readFileSync(path.join(repoRoot, COMPOSE_FILE), 'utf8');
const workflow = readFileSync(
  path.join(repoRoot, '.github/workflows/ci.yml'),
  'utf8',
);

const healthy = {
  versionOk: true,
  infoOk: true,
  infoOutput: '',
  composeOk: true,
};

test('describeDockerProblem accepts a working Docker', () => {
  assert.equal(describeDockerProblem(healthy), undefined);
});

test('describeDockerProblem tells a missing Docker from a stopped daemon', () => {
  const missing = describeDockerProblem({
    ...healthy,
    versionOk: false,
    versionError: 'spawnSync docker ENOENT',
  });
  assert.match(missing ?? '', /not installed/);
  const stopped = describeDockerProblem(
    {
      ...healthy,
      infoOk: false,
      infoOutput: 'Cannot connect to the Docker daemon',
    },
    'darwin',
  );
  assert.match(stopped ?? '', /not running/);
  assert.match(stopped ?? '', /Docker Desktop/);
  assert.match(stopped ?? '', /Cannot connect/);
  assert.match(
    describeDockerProblem({ ...healthy, infoOk: false }, 'linux') ?? '',
    /systemctl/,
  );
  assert.match(
    describeDockerProblem({ ...healthy, composeOk: false }) ?? '',
    /Compose/,
  );
});

test('parseRedisUrl reads host and port and rejects other schemes', () => {
  assert.deepEqual(parseRedisUrl('redis://10.0.0.5:6380'), {
    host: '10.0.0.5',
    port: 6380,
  });
  assert.deepEqual(parseRedisUrl('redis://cache'), {
    host: 'cache',
    port: 6379,
  });
  assert.equal(parseRedisUrl('http://127.0.0.1:6379'), undefined);
  assert.equal(parseRedisUrl('not a url'), undefined);
});

test('redisPreflight points at pnpm test:docker when Redis is missing', async () => {
  const unset = await redisPreflight({});
  assert.match(unset ?? '', /REDIS_URL is not set/);
  assert.match(unset ?? '', /pnpm test:docker/);

  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    assert.equal(
      await redisPreflight({ REDIS_URL: `redis://127.0.0.1:${port}` }),
      undefined,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const closed = await redisPreflight({
    REDIS_URL: `redis://127.0.0.1:${port}`,
  });
  assert.match(closed ?? '', /nothing answered/);
  assert.match(closed ?? '', /pnpm test:docker/);
});

test('testEnv sets every service variable and drops overrides', () => {
  const env = testEnv({
    REDIS_URL: 'redis://elsewhere:1',
    FILES_REDIS_URL: 'redis://elsewhere:2',
    FILEVORA_DATABASE_URL: 'sqlite://x',
    KEEP: 'yes',
  });
  assert.equal(env.REDIS_URL, TEST_ENV.REDIS_URL);
  assert.equal(env.FILES_REDIS_URL, undefined);
  assert.equal(env.FILEVORA_DATABASE_URL, undefined);
  assert.equal(env.KEEP, 'yes');
  for (const key of [
    'REDIS_URL',
    'FILEVORA_S3_ENDPOINT',
    'FILEVORA_S3_BUCKET',
    'FILEVORA_S3_ACCESS_KEY_ID',
    'FILEVORA_S3_SECRET_ACCESS_KEY',
    'FILEVORA_S3_REGION',
    'FILEVORA_POSTGRES_URL',
    'FILEVORA_MYSQL_URL',
  ]) {
    assert.ok(env[key], `${key} is set`);
  }
});

test('docker-compose.test.yml publishes the ports scripts/test-env.ts uses', () => {
  for (const [service, hostPort, containerPort] of [
    ['redis', SERVICE_PORTS.redis, 6379],
    ['minio', SERVICE_PORTS.minio, 9000],
    ['postgres', SERVICE_PORTS.postgres, 5432],
    ['mysql', SERVICE_PORTS.mysql, 3306],
  ] as const) {
    assert.ok(
      compose.includes(`'127.0.0.1:${hostPort}:${containerPort}'`),
      `${service} publishes ${hostPort}:${containerPort}`,
    );
  }
  assert.match(
    TEST_ENV.REDIS_URL ?? '',
    new RegExp(`:${SERVICE_PORTS.redis}$`),
  );
  assert.match(
    TEST_ENV.FILEVORA_POSTGRES_URL ?? '',
    new RegExp(`:${SERVICE_PORTS.postgres}/filevora$`),
  );
  assert.match(
    TEST_ENV.FILEVORA_MYSQL_URL ?? '',
    new RegExp(`:${SERVICE_PORTS.mysql}/filevora$`),
  );
  assert.match(
    TEST_ENV.FILEVORA_S3_ENDPOINT ?? '',
    new RegExp(`:${SERVICE_PORTS.minio}$`),
  );
});

test('docker-compose.test.yml matches the CI images and credentials', () => {
  for (const image of [
    'redis:7',
    'postgres:16',
    'mysql:8.4',
    'pgsty/silo:RELEASE.2026-11-12T00-00-00Z',
  ]) {
    assert.ok(compose.includes(`image: ${image}`), `compose pins ${image}`);
    assert.ok(workflow.includes(`image: ${image}`), `CI uses ${image}`);
  }
  assert.ok(compose.includes('MINIO_ROOT_USER: local'));
  assert.ok(compose.includes('MINIO_ROOT_PASSWORD: localpassword'));
  assert.equal(TEST_ENV.FILEVORA_S3_ACCESS_KEY_ID, 'local');
  assert.equal(TEST_ENV.FILEVORA_S3_SECRET_ACCESS_KEY, 'localpassword');
  assert.ok(compose.includes('POSTGRES_PASSWORD: filevora'));
  assert.ok(compose.includes('MYSQL_ROOT_PASSWORD: filevora'));
  assert.ok(compose.includes(TEST_ENV.FILEVORA_S3_BUCKET ?? 'missing'));
  assert.equal(compose.match(/healthcheck:/g)?.length, 4);
});
