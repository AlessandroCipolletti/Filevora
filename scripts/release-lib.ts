import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class ReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseError';
  }
}

export type BumpKind = 'patch' | 'minor' | 'major' | 'prerelease';

export const BUMP_KINDS: readonly BumpKind[] = [
  'patch',
  'minor',
  'major',
  'prerelease',
];

export const PRERELEASE_ID = 'beta';

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  pre?: { id: string; n: number };
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+)\.(\d+))?$/;

export function parseVersion(version: string): ParsedVersion {
  const match = VERSION_RE.exec(version);
  if (!match) {
    throw new ReleaseError(
      `Unsupported version "${version}". Use X.Y.Z or X.Y.Z-${PRERELEASE_ID}.N.`,
    );
  }
  const parsed: ParsedVersion = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
  if (match[4] !== undefined && match[5] !== undefined) {
    parsed.pre = { id: match[4], n: Number(match[5]) };
  }
  return parsed;
}

export function formatVersion(parsed: ParsedVersion): string {
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.pre ? `${core}-${parsed.pre.id}.${parsed.pre.n}` : core;
}

export function isPrerelease(version: string): boolean {
  return parseVersion(version).pre !== undefined;
}

export function distTagFor(version: string): 'latest' | 'next' {
  return isPrerelease(version) ? 'next' : 'latest';
}

export function isBumpKind(value: string): value is BumpKind {
  return (BUMP_KINDS as readonly string[]).includes(value);
}

export function bumpVersion(current: string, kind: BumpKind): string {
  const v = parseVersion(current);
  switch (kind) {
    case 'major':
      return formatVersion({
        major: v.pre && v.minor === 0 && v.patch === 0 ? v.major : v.major + 1,
        minor: 0,
        patch: 0,
      });
    case 'minor':
      return formatVersion({
        major: v.major,
        minor: v.pre && v.patch === 0 ? v.minor : v.minor + 1,
        patch: 0,
      });
    case 'patch':
      return formatVersion({
        major: v.major,
        minor: v.minor,
        patch: v.pre ? v.patch : v.patch + 1,
      });
    case 'prerelease':
      if (v.pre && v.pre.id === PRERELEASE_ID) {
        return formatVersion({ ...v, pre: { id: v.pre.id, n: v.pre.n + 1 } });
      }
      return formatVersion({
        major: v.major,
        minor: v.minor,
        patch: v.pre ? v.patch : v.patch + 1,
        pre: { id: PRERELEASE_ID, n: 0 },
      });
  }
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  if (x.pre.id !== y.pre.id) return x.pre.id < y.pre.id ? -1 : 1;
  if (x.pre.n === y.pre.n) return 0;
  return x.pre.n < y.pre.n ? -1 : 1;
}

export function resolveTargetVersion(current: string, target: string): string {
  if (isBumpKind(target)) return bumpVersion(current, target);
  parseVersion(target);
  if (compareVersions(target, current) < 0) {
    throw new ReleaseError(
      `Version ${target} is lower than the current version ${current}.`,
    );
  }
  return target;
}

export function setPackageVersion(
  packageJsonText: string,
  version: string,
): string {
  const pattern = /^(\s*"version":\s*")[^"]*(")/m;
  if (!pattern.test(packageJsonText)) {
    throw new ReleaseError('package.json has no "version" field to update.');
  }
  return packageJsonText.replace(pattern, `$1${version}$2`);
}

export function readPackageVersion(packageJsonText: string): string {
  const parsed = JSON.parse(packageJsonText) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw new ReleaseError('package.json has no string "version" field.');
  }
  parseVersion(parsed.version);
  return parsed.version;
}

export function formatDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const UNRELEASED_RE = /^##\s+\[?unreleased\]?\s*$/i;
const UNDATED_VERSION_RE = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?\s*$/;
const H2_RE = /^##\s/;

export interface ChangelogResult {
  text: string;
  changed: boolean;
  note: string;
}

export function rewriteChangelog(
  text: string,
  version: string,
  date: string,
): ChangelogResult {
  if (isPrerelease(version)) {
    return {
      text,
      changed: false,
      note: 'Prerelease: CHANGELOG.md is left alone. Entries move out of "Unreleased" at the next stable release.',
    };
  }
  const lines = text.split('\n');
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => H2_RE.test(line));
  const alreadyThere = headings.some(({ line }) => {
    const m = /^##\s+\[?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\]?/.exec(line);
    return m?.[1] === version;
  });
  const unreleased = headings.find(({ line }) => UNRELEASED_RE.test(line));
  const first = headings[0];

  if (unreleased) {
    if (alreadyThere) {
      throw new ReleaseError(
        `CHANGELOG.md already has an entry for ${version}. Remove it or pick another version.`,
      );
    }
    const next = headings.find(({ index }) => index > unreleased.index);
    const body = lines.slice(unreleased.index + 1, next?.index ?? lines.length);
    if (body.join('\n').trim() === '') {
      throw new ReleaseError(
        'CHANGELOG.md has an empty "## Unreleased" section. Add the entries for this release first.',
      );
    }
    lines.splice(
      unreleased.index,
      1,
      '## Unreleased',
      '',
      `## ${version} - ${date}`,
    );
    return {
      text: lines.join('\n'),
      changed: true,
      note: `Moved "Unreleased" entries under "${version} - ${date}".`,
    };
  }

  if (first) {
    const m = UNDATED_VERSION_RE.exec(first.line);
    if (m?.[1] === version) {
      lines.splice(
        first.index,
        1,
        '## Unreleased',
        '',
        `## ${version} - ${date}`,
      );
      return {
        text: lines.join('\n'),
        changed: true,
        note: `Dated the "${version}" entry ${date}.`,
      };
    }
    if (m) {
      throw new ReleaseError(
        `CHANGELOG.md has no "## Unreleased" section, and its top entry "${first.line.slice(3).trim()}" is an undated version that is not ${version}. For the first release of the version already in package.json, run "pnpm release ${m[1]}". Otherwise add the new entries under "## Unreleased" at the top.`,
      );
    }
  }
  throw new ReleaseError(
    'CHANGELOG.md has no "## Unreleased" section and no undated top entry, so the rewrite is not safe. Add "## Unreleased" above the latest version with the new entries.',
  );
}

const REDACTED = '[REDACTED]';

export function scrubSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 0) out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(/npm_[A-Za-z0-9]{16,}/g, REDACTED)
    .replace(/(_authToken\s*=\s*)\S+/gi, `$1${REDACTED}`)
    .replace(/(--otp[= ])\S+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)\S+/gi, `$1${REDACTED}`);
}

export function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match || match[1] === undefined) continue;
    let value = (match[2] ?? '').trim();
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.length >= 2 &&
      value.endsWith(quote)
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    result[match[1]] = value;
  }
  return result;
}

export interface TokenSource {
  token: string | undefined;
  source: 'env' | 'file' | 'none';
}

export function resolveNpmToken(
  env: Readonly<Record<string, string | undefined>>,
  fileText: string | undefined,
): TokenSource {
  const fromEnv = env.NPM_TOKEN?.trim();
  if (fromEnv) return validateToken(fromEnv, 'env');
  if (fileText !== undefined) {
    const fromFile = parseEnvFile(fileText).NPM_TOKEN?.trim();
    if (fromFile) return validateToken(fromFile, 'file');
  }
  return { token: undefined, source: 'none' };
}

function validateToken(token: string, source: 'env' | 'file'): TokenSource {
  if (/\s/.test(token)) {
    throw new ReleaseError(
      'NPM_TOKEN contains whitespace. Check the value (no quotes inside, one line).',
    );
  }
  return { token, source };
}

export interface TempNpmrc {
  path: string;
  dir: string;
  cleanup: () => void;
}

export function createTempNpmrc(
  token: string | undefined,
  baseDir: string = tmpdir(),
): TempNpmrc {
  const dir = mkdtempSync(path.join(baseDir, 'filevora-release-'));
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'npmrc');
  const lines = ['registry=https://registry.npmjs.org/'];
  if (token) lines.push(`//registry.npmjs.org/:_authToken=${token}`);
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  let cleaned = false;
  return {
    path: file,
    dir,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const REQUIRED_PACK_FILES = [
  'LICENSE',
  'README.md',
  'package.json',
  'capabilities.json',
  'bin/filevora.js',
  'dist/server/index.js',
  'dist/server/index.d.ts',
  'dist/cli/main.js',
] as const;

const ALLOWED_TOP_LEVEL = new Set([
  'LICENSE',
  'README.md',
  'package.json',
  'capabilities.json',
]);

export function verifyPackFiles(files: readonly string[]): string[] {
  const problems: string[] = [];
  const set = new Set(files);
  for (const required of REQUIRED_PACK_FILES) {
    if (!set.has(required)) problems.push(`missing ${required}`);
  }
  for (const file of files) {
    const top = file.split('/')[0] ?? file;
    const inAllowedDir =
      file.includes('/') && (top === 'bin' || top === 'dist');
    if (!ALLOWED_TOP_LEVEL.has(file) && !inAllowedDir) {
      problems.push(`unexpected file ${file}`);
      continue;
    }
    if (/(^|\/)[^/]*\.(test|spec)\.[cm]?[jt]sx?(\.map)?$/.test(file)) {
      problems.push(`test file ${file}`);
    } else if (/\.[cm]?ts$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) {
      problems.push(`TypeScript source ${file}`);
    } else if (/(^|\/)\.env/.test(file)) {
      problems.push(`env file ${file}`);
    }
  }
  return problems;
}
