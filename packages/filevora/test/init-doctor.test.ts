import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/cli/main.js';
import { runDoctor } from '../dist/diagnostics/doctor.js';
import { createFilesHandler } from '../dist/http/index.js';
import { createFiles } from '../dist/server/index.js';

test('init detects the framework and does not overwrite without --force', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-init-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      dependencies: { express: '4.0.0' },
      packageManager: 'pnpm@10.0.0',
    }),
  );
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const lines: string[] = [];
  const preview = await runCli(
    ['init', '--dir', dir, '--mode', 'lite', '--dry-run', '--json'],
    {},
    { stdout: (line) => lines.push(line), stderr: () => undefined },
  );
  assert.equal(preview, 0);
  const plan = JSON.parse(lines.join('')) as {
    dryRun: boolean;
    framework: string;
    packageManager: string;
    mode: string;
    migration: string;
  };
  assert.equal(plan.dryRun, true);
  assert.equal(plan.framework, 'express');
  assert.equal(plan.packageManager, 'pnpm');
  assert.equal(plan.mode, 'lite');
  assert.equal(existsSync(path.join(dir, 'filevora', 'handler.ts')), false);
  assert.match(plan.migration, /No migration/);

  const written: string[] = [];
  const created = await runCli(
    ['init', '--dir', dir, '--mode', 'stored', '--json'],
    {},
    { stdout: (line) => written.push(line), stderr: () => undefined },
  );
  assert.equal(created, 0);
  const body = JSON.parse(written.join('')) as { migration: string };
  assert.match(body.migration, /filevora migrate/);
  assert.equal(existsSync(path.join(dir, '.env.filevora.example')), true);
  const env = (await import('node:fs')).readFileSync(
    path.join(dir, '.env.filevora.example'),
    'utf8',
  );
  assert.match(env, /FILEVORA_DATABASE_URL=/);
  assert.doesNotMatch(env, /FILEVORA_MALWARE_SCAN/);
  const handler = (await import('node:fs')).readFileSync(
    path.join(dir, 'filevora', 'handler.ts'),
    'utf8',
  );
  const snippet = (await import('node:fs')).readFileSync(
    path.join(dir, 'filevora', 'upload-snippet.ts'),
    'utf8',
  );
  assert.match(handler, /basePath: '\/api\/files'/);
  assert.match(snippet, /endpoint: '\/api\/files'/);

  const again: string[] = [];
  const blocked = await runCli(
    ['init', '--dir', dir, '--json'],
    {},
    {
      stdout: (line) => again.push(line),
      stderr: () => undefined,
    },
  );
  assert.equal(blocked, 1);
  assert.equal(JSON.parse(again.join('')).code, 'INIT_EXISTS');
  rmSync(dir, { recursive: true, force: true });
});

test('doctor names the mode, the storage round trip, and a missing Redis URL', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-doctor-'));
  mkdirSync(dir, { recursive: true });
  const report = await runDoctor(
    { env: 'test', storage: { root: dir }, runtime: 'long-running' },
    { FILES_ENV: 'test', NODE_ENV: 'test' },
  );
  const byId = Object.fromEntries(
    report.checks.map((check) => [check.id, check]),
  );
  assert.equal(byId.mode?.status, 'pass');
  assert.match(byId.mode?.message ?? '', /lite/);
  assert.equal(byId.storage?.code, 'OK');
  assert.equal(byId.redis?.code, 'DOCTOR_REDIS_UNSET');
  assert.equal(byId.redis?.status, 'warn');
  assert.match(byId.redis?.fix ?? '', /REDIS_URL/);
  assert.equal(typeof byId.ffprobe?.code, 'string');
  assert.equal(byId.scanner?.code, 'OK');
  const bad = await runDoctor(
    {},
    {
      FILES_ENV: 'test',
      FILES_STORAGE_ROOT: dir,
      REDIS_URL: 'redis://127.0.0.1:1',
    },
  );
  const redis = bad.checks.find((check) => check.id === 'redis');
  assert.equal(redis?.status, 'fail');
  assert.equal(redis?.code, 'DOCTOR_REDIS_UNREACHABLE');
  assert.equal(bad.ok, false);
  rmSync(dir, { recursive: true, force: true });
});

test('the health route returns doctor JSON without authentication', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-health-'));
  const files = createFiles({
    env: 'test',
    storage: { root: dir },
    runtime: 'long-running',
  });
  const handler = createFilesHandler({
    files,
    health: true,
    async authenticate() {
      return null;
    },
    async authorize() {
      return false;
    },
    async policy() {
      return {};
    },
  });
  const response = await handler(new Request('http://app.local/health'));
  const body = (await response.json()) as { checks: Array<{ id: string }> };
  assert.equal(response.status === 200 || response.status === 503, true);
  assert.ok(body.checks.some((check) => check.id === 'mode'));
  await files.close();
  rmSync(dir, { recursive: true, force: true });
});
