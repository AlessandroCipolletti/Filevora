import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../dist/cli/main.js';
import { createFiles } from '../dist/server/index.js';
import { runWorker } from '../dist/worker/index.js';
import { workerConfigOptions } from '../dist/worker/supervisor.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const principal = { id: 'user-a', tenantId: 'tenant-a' };

function filesFor(dir: string, spawn: 'on-demand' | 'never') {
  return createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    upload: { chunkBytes: 64 * 1024 },
    queue: { leaseSeconds: 2, pollIntervalMs: 50, maxAttempts: 5 },
    processing: { mode: spawn === 'never' ? 'inline' : 'worker', spawn },
    defaults: { allowedMimeTypes: ['image/png'] },
  });
}

async function uploaded(files: ReturnType<typeof filesFor>) {
  const session = await files.createUploadSession(
    { filename: 'dot.png', mimeType: 'image/png', bytes: PNG.byteLength },
    { principal },
  );
  await files.writePart(session.id, 1, PNG, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the worker');
}

test('a second supervisor call does not spawn another worker, and a killed job finishes once', {
  timeout: 20_000,
}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m3-'));
  const files = filesFor(dir, 'on-demand');
  try {
    const record = await uploaded(files);
    const job = await files.process(
      record.id,
      { delayMs: 1_500 },
      { principal },
    );
    const firstPid = files.ensureWorker();
    const secondPid = files.ensureWorker();
    assert.equal(firstPid, secondPid);
    assert.ok(firstPid > 0);
    assert.notEqual(firstPid, process.pid);
    await waitFor(async () => {
      const current = await files.getJob(job.id, { principal });
      return current.state === 'processing' && current.attempts >= 1;
    });
    process.kill(firstPid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const recoveredPid = files.ensureWorker();
    assert.notEqual(recoveredPid, firstPid);
    await waitFor(
      async () =>
        (await files.getJob(job.id, { principal })).state === 'succeeded',
    );
    const finished = await files.getJob(job.id, { principal });
    assert.equal(finished.attempts >= 2, true);
    assert.equal(finished.result?.held, true);
    const again = await files.getJob(job.id, { principal });
    assert.equal(again.state, 'succeeded');
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preset jobs fail closed until a processor exists, and doctor reports json', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-m3-doctor-'));
  const files = filesFor(dir, 'never');
  try {
    const record = await uploaded(files);
    const job = await files.process(record.id, {}, { principal });
    await runWorker({ once: true, options: workerConfigOptions(files.config) });
    const finished = await files.getJob(job.id, { principal });
    assert.equal(finished.state, 'failed');
    assert.equal(finished.errorCode, 'PROCESSOR_UNAVAILABLE');
    const lines: string[] = [];
    const code = await runCli(
      ['doctor', '--json'],
      {
        FILES_ENV: 'test',
        FILES_RUNTIME: 'long-running',
        FILES_STORAGE_ROOT: path.join(dir, 'objects'),
        FILES_SQLITE_PATH: path.join(dir, 'doctor.sqlite'),
      },
      { stdout: (line) => lines.push(line), stderr: () => undefined },
    );
    assert.equal(code, 0);
    const report = JSON.parse(lines.join('')) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(report.ok, true);
    assert.equal(
      report.checks.some(
        (check) => check.id === 'ffmpeg' && check.status === 'pass',
      ),
      true,
    );
    const bad: string[] = [];
    const failed = await runCli(
      ['doctor', '--json'],
      { FILES_PROVIDER: 'managed' },
      {
        stdout: (line) => bad.push(line),
        stderr: () => undefined,
      },
    );
    assert.equal(failed, 1);
    const failure = JSON.parse(bad.join('')) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    assert.equal(failure.ok, false);
    assert.equal(
      failure.checks.find((check) => check.id === 'config')?.status,
      'fail',
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
