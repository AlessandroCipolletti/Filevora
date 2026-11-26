import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  ReleaseError,
  bumpVersion,
  createTempNpmrc,
  distTagFor,
  parseEnvFile,
  resolveNpmToken,
  resolveTargetVersion,
  rewriteChangelog,
  scrubSecrets,
  setPackageVersion,
  stripSecretEnv,
  verifyPackFiles,
} from './release-lib.ts';

test('bumpVersion follows semver and uses the beta id for prereleases', () => {
  assert.equal(bumpVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.1.4', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.9.2', 'major'), '1.0.0');
  assert.equal(bumpVersion('0.1.0', 'prerelease'), '0.1.1-beta.0');
  assert.equal(bumpVersion('0.1.1-beta.0', 'prerelease'), '0.1.1-beta.1');
  assert.equal(bumpVersion('0.1.1-beta.3', 'patch'), '0.1.1');
  assert.equal(bumpVersion('0.2.0-beta.1', 'minor'), '0.2.0');
  assert.equal(bumpVersion('0.2.1-beta.1', 'minor'), '0.3.0');
  assert.equal(bumpVersion('1.0.0-beta.1', 'major'), '1.0.0');
  assert.equal(bumpVersion('0.1.1-rc.2', 'prerelease'), '0.1.1-beta.0');
});

test('explicit versions must parse and not go backwards', () => {
  assert.equal(resolveTargetVersion('0.1.0', '0.1.0'), '0.1.0');
  assert.equal(resolveTargetVersion('0.1.0', '0.2.0-beta.0'), '0.2.0-beta.0');
  assert.throws(() => resolveTargetVersion('0.2.0', '0.1.0'), ReleaseError);
  assert.throws(() => resolveTargetVersion('0.1.0', 'next'), ReleaseError);
});

test('prereleases publish under the next tag', () => {
  assert.equal(distTagFor('0.1.1-beta.0'), 'next');
  assert.equal(distTagFor('0.1.1'), 'latest');
});

test('setPackageVersion changes only the version line', () => {
  const text = '{\n  "name": "filevora",\n  "version": "0.1.0",\n  "x": 1\n}\n';
  assert.equal(
    setPackageVersion(text, '0.1.1'),
    '{\n  "name": "filevora",\n  "version": "0.1.1",\n  "x": 1\n}\n',
  );
});

test('rewriteChangelog moves Unreleased entries under the new version', () => {
  const text =
    '# Changelog\n\n## Unreleased\n\n- New thing\n\n## 0.1.0 - 2026-01-01\n\n- Old\n';
  const result = rewriteChangelog(text, '0.1.1', '2026-02-03');
  assert.equal(result.changed, true);
  assert.equal(
    result.text,
    '# Changelog\n\n## Unreleased\n\n## 0.1.1 - 2026-02-03\n\n- New thing\n\n## 0.1.0 - 2026-01-01\n\n- Old\n',
  );
});

test('rewriteChangelog dates an undated top entry for the first release', () => {
  const text = '# Changelog\n\n## 0.1.0\n\n- First\n';
  const result = rewriteChangelog(text, '0.1.0', '2026-11-26');
  assert.equal(
    result.text,
    '# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-11-26\n\n- First\n',
  );
});

test('rewriteChangelog fails clearly when the rewrite is not safe', () => {
  assert.throws(
    () =>
      rewriteChangelog(
        '# Changelog\n\n## 0.1.0\n\n- First\n',
        '0.1.1',
        '2026-11-26',
      ),
    /pnpm release 0\.1\.0/,
  );
  assert.throws(
    () =>
      rewriteChangelog(
        '# Changelog\n\n## Unreleased\n\n## 0.1.0 - 2026-01-01\n',
        '0.1.1',
        'd',
      ),
    /empty/,
  );
  assert.throws(
    () =>
      rewriteChangelog(
        '# Changelog\n\n## 0.1.0 - 2026-01-01\n\n- x\n',
        '0.1.1',
        'd',
      ),
    /no "## Unreleased"/,
  );
  assert.throws(
    () =>
      rewriteChangelog(
        '# Changelog\n\n## Unreleased\n\n- a\n\n## 0.1.1 - 2026-01-01\n',
        '0.1.1',
        'd',
      ),
    /already has an entry/,
  );
});

test('rewriteChangelog leaves the file alone for a prerelease', () => {
  const text = '# Changelog\n\n## Unreleased\n\n- a\n';
  const result = rewriteChangelog(text, '0.1.1-beta.0', '2026-11-26');
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
});

test('scrubSecrets removes known secrets and npm token shapes', () => {
  const token = 'npm_abcdefghijklmnop1234567890';
  const out = scrubSecrets(
    `auth failed for ${token}\n//registry.npmjs.org/:_authToken=${token}\nnpm publish --otp 123456\nuser-secret-value`,
    [token, '123456', 'user-secret-value'],
  );
  assert.ok(!out.includes(token));
  assert.ok(!out.includes('123456'));
  assert.ok(!out.includes('user-secret-value'));
  assert.match(out, /_authToken=\[REDACTED\]/);
  assert.match(scrubSecrets('npm_ZZZZZZZZZZZZZZZZZZZZ', []), /\[REDACTED\]/);
});

test('parseEnvFile and resolveNpmToken read the env first, then the file', () => {
  const file = '# comment\nexport NPM_TOKEN="npm_fromfile"\nOTHER=1\n';
  assert.deepEqual(parseEnvFile(file), {
    NPM_TOKEN: 'npm_fromfile',
    OTHER: '1',
  });
  assert.deepEqual(resolveNpmToken({ NPM_TOKEN: 'npm_env' }, file), {
    token: 'npm_env',
    source: 'env',
  });
  assert.deepEqual(resolveNpmToken({}, file), {
    token: 'npm_fromfile',
    source: 'file',
  });
  assert.deepEqual(resolveNpmToken({}, 'NPM_TOKEN=\n'), {
    token: undefined,
    source: 'none',
  });
  assert.throws(
    () => resolveNpmToken({ NPM_TOKEN: 'a b' }, undefined),
    ReleaseError,
  );
});

test('temp npmrc is private and removed by cleanup', () => {
  const rc = createTempNpmrc('npm_secretsecretsecret', tmpdir());
  assert.ok(existsSync(rc.path));
  assert.equal(statSync(rc.path).mode & 0o777, 0o600);
  assert.match(
    readFileSync(rc.path, 'utf8'),
    /:_authToken=npm_secretsecretsecret/,
  );
  rc.cleanup();
  assert.ok(!existsSync(rc.path));
  assert.ok(!existsSync(rc.dir));
  rc.cleanup();
  const anon = createTempNpmrc(undefined, tmpdir());
  assert.ok(!readFileSync(anon.path, 'utf8').includes('_authToken'));
  anon.cleanup();
});

test('verifyPackFiles requires the shipped files and rejects tests and sources', () => {
  const good = [
    'LICENSE',
    'README.md',
    'package.json',
    'capabilities.json',
    'bin/filevora.js',
    'bin/sqlite-quiet.js',
    'dist/server/index.js',
    'dist/server/index.d.ts',
    'dist/server/index.js.map',
    'dist/cli/main.js',
  ];
  assert.deepEqual(verifyPackFiles(good), []);
  assert.deepEqual(verifyPackFiles(good.filter((f) => f !== 'LICENSE')), [
    'missing LICENSE',
  ]);
  const bad = verifyPackFiles([
    ...good,
    'src/server/index.ts',
    'test/m0.test.ts',
    'dist/server/x.test.js',
    'dist/server/y.ts',
  ]);
  assert.ok(bad.some((p) => p.includes('src/server/index.ts')));
  assert.ok(bad.some((p) => p.includes('test/m0.test.ts')));
  assert.ok(bad.some((p) => p.includes('dist/server/x.test.js')));
  assert.ok(bad.some((p) => p.includes('dist/server/y.ts')));
});

test('stripSecretEnv drops npm credentials and keeps the rest', () => {
  const env = stripSecretEnv({
    NPM_TOKEN: 'npm_secret',
    NPM_OTP: '123456',
    NODE_AUTH_TOKEN: 'x',
    REDIS_URL: 'redis://127.0.0.1:1',
    PATH: '/usr/bin',
  });
  assert.deepEqual(env, { REDIS_URL: 'redis://127.0.0.1:1', PATH: '/usr/bin' });
});
