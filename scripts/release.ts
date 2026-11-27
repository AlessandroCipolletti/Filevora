import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  BUMP_KINDS,
  ReleaseError,
  createTempNpmrc,
  distTagFor,
  formatDate,
  readPackageVersion,
  resolveNpmToken,
  resolveTargetVersion,
  rewriteChangelog,
  scrubSecrets,
  setFilevoraVersionSource,
  setPackageVersion,
  stripSecretEnv,
  verifyPackFiles,
  type TempNpmrc,
} from './release-lib.ts';
import {
  checkDocker,
  emergencyStop,
  installTeardownSignals,
  runTestsInDocker,
} from './docker-services.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'packages/filevora');
const pkgJsonPath = path.join(pkgDir, 'package.json');
const versionSourcePath = path.join(pkgDir, 'src/version.ts');
const changelogPath = path.join(root, 'CHANGELOG.md');
const tokenFile = path.join(root, '.env.release.local');

const usage = `Usage: pnpm release <patch|minor|major|prerelease|X.Y.Z>
       pnpm release:dry <patch|minor|major|prerelease|X.Y.Z>

An explicit version is for the first publish of the version already in
packages/filevora/package.json (pnpm release 0.1.0) or a prerelease such as
0.2.0-beta.0. Set NPM_TOKEN, or put it in .env.release.local. Set NPM_OTP if the
account needs a one-time code.`;

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const positional = args.filter((arg) => !arg.startsWith('--'));

let secrets: string[] = [];
let npmrc: TempNpmrc | undefined;

function log(message: string): void {
  process.stdout.write(`${scrubSecrets(message, secrets)}\n`);
}

function step(message: string): void {
  log(`\n==> ${message}`);
}

function cleanup(): void {
  npmrc?.cleanup();
}

interface RunOptions {
  cwd?: string;
  capture?: boolean;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function cleanEnv(): NodeJS.ProcessEnv {
  return stripSecretEnv(process.env);
}

function run(
  command: string,
  cmdArgs: string[],
  opts: RunOptions = {},
): RunResult {
  const result = spawnSync(command, cmdArgs, {
    cwd: opts.cwd ?? root,
    env: opts.env ?? cleanEnv(),
    encoding: 'utf8',
    stdio: opts.capture
      ? ['ignore', 'pipe', 'pipe']
      : ['ignore', 'inherit', 'inherit'],
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = scrubSecrets(result.stdout ?? '', secrets);
  const stderr = scrubSecrets(result.stderr ?? '', secrets);
  const status = result.status ?? 1;
  if (result.error) {
    throw new ReleaseError(
      `Could not run "${command}": ${scrubSecrets(result.error.message, secrets)}`,
    );
  }
  if (status !== 0 && !opts.allowFailure) {
    const shown = [command, ...cmdArgs].join(' ');
    throw new ReleaseError(
      `Command failed (exit ${status}): ${scrubSecrets(shown, secrets)}${
        stderr.trim() ? `\n${stderr.trim()}` : ''
      }`,
    );
  }
  return { status, stdout, stderr };
}

function git(gitArgs: string[], opts: RunOptions = {}): string {
  return run('git', gitArgs, { capture: true, ...opts }).stdout.trim();
}

function checkGit(): string {
  step('Check git: clean tree, master, in sync with origin');
  const status = git(['status', '--porcelain']);
  if (status !== '') {
    throw new ReleaseError(
      `The git tree is not clean. Commit or stash first:\n${status}`,
    );
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'master') {
    throw new ReleaseError(
      `Releases run from master, but you are on "${branch}".`,
    );
  }
  run('git', ['fetch', '--quiet', 'origin', 'master', '--tags'], {
    capture: true,
  });
  const head = git(['rev-parse', 'HEAD']);
  const remote = git(['rev-parse', 'origin/master']);
  if (head !== remote) {
    const counts = git([
      'rev-list',
      '--left-right',
      '--count',
      'HEAD...origin/master',
    ]);
    const [ahead = '0', behind = '0'] = counts.split(/\s+/);
    throw new ReleaseError(
      `master is not in sync with origin/master (${ahead} ahead, ${behind} behind). ${
        Number(behind) > 0
          ? 'Run git pull --ff-only.'
          : 'Push first and wait for CI.'
      }`,
    );
  }
  log(`master is clean and at ${head.slice(0, 7)}.`);
  return head;
}

function loadToken(): void {
  step('Load the npm token');
  let fileText: string | undefined;
  if (existsSync(tokenFile)) {
    const mode = statSync(tokenFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      log(
        `warning: .env.release.local is readable by other users (mode ${mode.toString(8)}). Run chmod 600 .env.release.local.`,
      );
    }
    fileText = readFileSync(tokenFile, 'utf8');
  }
  const { token, source } = resolveNpmToken(process.env, fileText);
  const otp = process.env.NPM_OTP?.trim();
  secrets = [token, otp].filter((value): value is string => Boolean(value));
  if (!token) {
    if (!dry) {
      throw new ReleaseError(
        'No npm token. Set NPM_TOKEN or put NPM_TOKEN=... in .env.release.local (see .env.release.local.example).',
      );
    }
    log('No NPM_TOKEN found. Continuing: the dry run does not need one.');
  } else {
    log(
      source === 'env'
        ? 'Token loaded from the NPM_TOKEN environment variable.'
        : 'Token loaded from .env.release.local.',
    );
  }
  if (otp) log('NPM_OTP is set and will be passed to npm publish.');
  npmrc = createTempNpmrc(token);
}

function npmEnv(): NodeJS.ProcessEnv {
  if (!npmrc)
    throw new ReleaseError('Internal error: temporary npmrc missing.');
  return { ...cleanEnv(), NPM_CONFIG_USERCONFIG: npmrc.path };
}

function npm(npmArgs: string[], opts: RunOptions = {}): RunResult {
  if (!npmrc)
    throw new ReleaseError('Internal error: temporary npmrc missing.');
  return run('npm', [...npmArgs, '--userconfig', npmrc.path], {
    env: npmEnv(),
    ...opts,
  });
}

function checkNotPublished(version: string, hasToken: boolean): void {
  step(`Check ${version} is not on the registry`);
  const view = npm(['view', `filevora@${version}`, 'version'], {
    capture: true,
    allowFailure: true,
  });
  if (view.status === 0 && view.stdout.trim() !== '') {
    throw new ReleaseError(`filevora@${version} is already published.`);
  }
  if (
    !/E404|404 Not Found/.test(`${view.stdout}${view.stderr}`) &&
    view.status !== 0
  ) {
    log(
      `warning: could not query the registry, continuing.\n${view.stderr.trim()}`,
    );
    return;
  }
  log(`filevora@${version} is free.`);
  if (hasToken && !dry) {
    const who = npm(['whoami'], { capture: true, allowFailure: true });
    if (who.status === 0) {
      log(`npm identity: ${who.stdout.trim()}`);
    } else if (/E401|ENEEDAUTH|Unauthorized/i.test(who.stderr)) {
      throw new ReleaseError(
        `npm rejected the token (401). Create a new granular access token at npmjs.com.\n${who.stderr.trim()}`,
      );
    } else {
      log(
        'warning: npm whoami did not confirm the identity. Continuing; publish will say if the token is wrong.',
      );
    }
  }
}

function checkDockerReady(): void {
  step('Check Docker (the tests run against Redis, MinIO, Postgres, MySQL)');
  checkDocker();
  log('Docker and Docker Compose are available and the daemon is running.');
}

async function runChecks(): Promise<void> {
  step('Typecheck, lint, knip, circular imports, manifest (pnpm run ci)');
  run('pnpm', ['run', 'ci']);
  step(
    'Full tests against Docker services (same path as pnpm test:docker; no networked test is skipped)',
  );
  const code = await runTestsInDocker({ env: cleanEnv(), log });
  if (code !== 0) {
    throw new ReleaseError(
      `The full test suite failed (exit ${code}). Nothing was published. Fix the failures, or run pnpm test:docker to reproduce.`,
    );
  }
}

function build(): void {
  step('Build (pnpm build)');
  run('pnpm', ['build']);
}

function verifyPack(): void {
  step('Verify the packed file list');
  const packed = npm(['pack', '--json', '--dry-run'], {
    cwd: pkgDir,
    capture: true,
  });
  let files: string[];
  try {
    const parsed = JSON.parse(packed.stdout) as { files: { path: string }[] }[];
    files = (parsed[0]?.files ?? []).map((f) => f.path);
  } catch {
    throw new ReleaseError(
      `Could not read npm pack --json output:\n${packed.stdout}`,
    );
  }
  const problems = verifyPackFiles(files);
  if (problems.length > 0) {
    throw new ReleaseError(
      `The npm tarball is wrong:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  log(
    `Tarball has ${files.length} files. LICENSE, README, bin, dist present; no tests or sources.`,
  );
}

function publish(version: string, tag: 'latest' | 'next'): void {
  step(dry ? `npm publish --dry-run (${tag})` : `npm publish (${tag})`);
  const publishArgs = ['publish', '--access', 'public', '--tag', tag];
  const otp = process.env.NPM_OTP?.trim();
  if (otp) publishArgs.push('--otp', otp);
  if (dry) publishArgs.push('--dry-run');
  const result = npm(publishArgs, {
    cwd: pkgDir,
    capture: true,
    allowFailure: true,
  });
  if (result.stdout.trim()) log(result.stdout.trim());
  if (result.stderr.trim()) log(result.stderr.trim());
  if (result.status !== 0) {
    const text = `${result.stdout}${result.stderr}`;
    const hint = /EOTP|one-time password|OTP/i.test(text)
      ? '\nThis account needs a one-time code: rerun with NPM_OTP=123456 (a fresh code).'
      : /E403|forbidden/i.test(text)
        ? '\nThe token may lack read and write on filevora, or the version already exists.'
        : '';
    throw new ReleaseError(
      `npm publish failed for filevora@${version}.${hint}`,
    );
  }
}

async function main(): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  const target = positional[0];
  if (!target || positional.length > 1) {
    throw new ReleaseError(`Expected one argument.\n${usage}`);
  }
  const label = dry ? 'release:dry' : 'release';
  log(`${label}: ${target}`);

  checkDockerReady();
  const startSha = checkGit();
  loadToken();

  const pkgJsonText = readFileSync(pkgJsonPath, 'utf8');
  const current = readPackageVersion(pkgJsonText);
  const next = resolveTargetVersion(current, target);
  const tag = distTagFor(next);
  const date = formatDate(new Date());
  const changelog = rewriteChangelog(
    readFileSync(changelogPath, 'utf8'),
    next,
    date,
  );
  log(`\nVersion: ${current} -> ${next} (dist-tag ${tag}). ${changelog.note}`);
  const gitTag = `v${next}`;
  if (git(['tag', '--list', gitTag]) !== '') {
    throw new ReleaseError(`The git tag ${gitTag} already exists.`);
  }
  const remoteTag = git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${gitTag}`,
  ]);
  if (remoteTag !== '') {
    throw new ReleaseError(`The git tag ${gitTag} already exists on origin.`);
  }
  checkNotPublished(next, secrets.length > 0);

  await runChecks();
  build();
  verifyPack();

  if (dry) {
    publish(next, tag);
    log(
      `\nDry run finished. Skipped: version bump, CHANGELOG edit, commit, tag, push, publish. Next: pnpm release ${target}.`,
    );
    return;
  }

  step(`Bump to ${next}, update CHANGELOG, commit, tag`);
  let committed = false;
  try {
    if (next !== current) {
      writeFileSync(pkgJsonPath, setPackageVersion(pkgJsonText, next));
      writeFileSync(
        versionSourcePath,
        setFilevoraVersionSource(readFileSync(versionSourcePath, 'utf8'), next),
      );
    }
    if (changelog.changed) writeFileSync(changelogPath, changelog.text);
    git([
      'add',
      'packages/filevora/package.json',
      'packages/filevora/src/version.ts',
      'CHANGELOG.md',
    ]);
    git(['commit', '--no-verify', '--allow-empty', '-m', `release: ${gitTag}`]);
    committed = true;
    git(['tag', '-a', gitTag, '-m', `filevora ${next}`]);
    publish(next, tag);
  } catch (error) {
    log(
      '\nRelease failed before the push. Restoring the repo so it stays releasable.',
    );
    run('git', ['tag', '-d', gitTag], { capture: true, allowFailure: true });
    run('git', ['reset', '--hard', startSha], { capture: true });
    log(
      committed
        ? `Undid the local commit and tag ${gitTag}. HEAD is back at ${startSha.slice(0, 7)}.`
        : `Reverted the working tree to ${startSha.slice(0, 7)}.`,
    );
    log(
      'Nothing was pushed. If the failure was ambiguous, check "npm view filevora versions" before retrying.',
    );
    throw error;
  }

  step('Push commit and tag');
  try {
    run('git', ['push', 'origin', 'master']);
    run('git', ['push', 'origin', gitTag]);
  } catch (error) {
    log(
      `\nfilevora@${next} IS PUBLISHED on npm, but the push failed. Do not rerun the release. Run: git push origin master && git push origin ${gitTag}`,
    );
    throw error;
  }
  log(`\nReleased filevora@${next} (dist-tag ${tag}) as ${gitTag}.`);
}

installTeardownSignals(cleanup, log);

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nrelease: ${scrubSecrets(message, secrets)}\n`);
  if (error instanceof ReleaseError && /^Version|^Unsupported/.test(message)) {
    process.stderr.write(
      `Kinds: ${BUMP_KINDS.join(', ')} or an explicit version.\n`,
    );
  }
  process.exitCode = 1;
} finally {
  emergencyStop(log);
  cleanup();
}
