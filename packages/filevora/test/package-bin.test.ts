import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('package.json bin is a plain relative path with a node shebang', () => {
  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as { bin: Record<string, string> };
  assert.equal(manifest.bin.filevora, 'bin/filevora.js');
  assert.match(
    readFileSync(path.join(packageRoot, manifest.bin.filevora), 'utf8'),
    /^#!\/usr\/bin\/env node\n/,
  );
});

test('the bin runs the CLI and CommonJS can load the entries', () => {
  const version = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'bin/filevora.js'), '--version'],
    { encoding: 'utf8' },
  );
  assert.equal(version.status, 0);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
  assert.equal(version.stderr.includes('ExperimentalWarning'), false);

  const help = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'bin/filevora.js'), 'worker', '--help'],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /filevora worker/);

  const env = { ...process.env };
  delete env.REDIS_URL;
  delete env.FILES_REDIS_URL;
  delete env.FILEVORA_CONFIG_PATH;
  const worker = spawnSync(
    process.execPath,
    [path.join(packageRoot, 'bin/filevora.js'), 'worker'],
    { encoding: 'utf8', env, timeout: 8_000, killSignal: 'SIGKILL' },
  );
  assert.equal(worker.status, 1);
  assert.match(`${worker.stdout}${worker.stderr}`, /REDIS_URL/);

  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-cjs-'));
  mkdirSync(path.join(dir, 'node_modules'));
  symlinkSync(packageRoot, path.join(dir, 'node_modules/filevora'));
  try {
    const loaded = spawnSync(
      process.execPath,
      [
        '--input-type=commonjs',
        '-e',
        `const path = require('node:path');
         const client = require('filevora/client');
         const server = require('filevora/server');
         const sqlite = require(path.join(process.cwd(), 'node_modules/filevora/dist/metadata/sqlite.js'));
         if (typeof client.createUploadClient !== 'function') process.exit(2);
         if (typeof server.createFiles !== 'function') process.exit(3);
         const db = sqlite.openSqlite(path.join(process.cwd(), 'meta.sqlite'));
         db.close();`,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    assert.equal(
      /SQLite is an experimental feature/.test(loaded.stderr),
      false,
    );
    assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
