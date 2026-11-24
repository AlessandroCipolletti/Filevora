import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { runDoctor } from '../diagnostics/doctor.js';
import { isFileSdkError } from '../errors/error.js';
import { FILEVORA_VERSION } from '../version.js';

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { name?: string };
      if (pkg.name === 'filevora') return dir;
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the filevora package root.');
}

function helpText(): string {
  return [
    'filevora — headless file upload SDK',
    '',
    'No Filevora account is required. Managed hosting is not part of this package.',
    '',
    'Usage:',
    '  filevora capabilities --json',
    '  filevora config validate --json',
    '  filevora doctor --json',
    '  filevora migrate',
    '  filevora cleanup [--dry-run] [--json]',
    '  filevora worker',
    '  filevora --help',
    '  filevora --version',
    '',
    'inspect and init are added in later milestones.',
    `version ${FILEVORA_VERSION}`,
  ].join('\n');
}

function printError(io: CliIo, json: boolean, error: unknown): void {
  if (isFileSdkError(error)) {
    const body = error.toJSON();
    if (json) io.stdout(`${JSON.stringify({ ok: false, error: body })}\n`);
    else io.stderr(`${body.code}: ${body.message}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown CLI error';
  if (json)
    io.stdout(
      `${JSON.stringify({ ok: false, error: { code: 'INTERNAL', message } })}\n`,
    );
  else io.stderr(`${message}\n`);
}

/**
 * Run the Filevora CLI. Returns a process exit code and does not exit itself.
 */
export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io?: CliIo,
): Promise<number> {
  const out = io ?? {
    stdout: (line) => process.stdout.write(line),
    stderr: (line) => process.stderr.write(line),
  };
  const json = argv.includes('--json');
  const args = argv.filter((arg) => arg !== '--json');
  const [command, sub] = args;

  try {
    if (!command || command === '--help' || command === '-h') {
      out.stdout(`${helpText()}\n`);
      return 0;
    }
    if (command === '--version' || command === '-v') {
      out.stdout(`${FILEVORA_VERSION}\n`);
      return 0;
    }
    if (command === 'capabilities') {
      const raw = readFileSync(
        path.join(packageRoot(), 'capabilities.json'),
        'utf8',
      );
      const manifest = JSON.parse(raw) as { version?: string };
      if (manifest.version !== FILEVORA_VERSION) {
        throw new Error(
          `capabilities.json version ${manifest.version} does not match ${FILEVORA_VERSION}`,
        );
      }
      out.stdout(json ? (raw.endsWith('\n') ? raw : `${raw}\n`) : `${raw}\n`);
      return 0;
    }
    if (command === 'config' && sub === 'validate') {
      const configPath = readOption(args, '--config');
      const fileOptions = configPath
        ? (JSON.parse(readFileSync(configPath, 'utf8')) as FilesOptions)
        : {};
      const config = resolveConfig(fileOptions, env);
      out.stdout(
        `${JSON.stringify({ ok: true, config: redactConfig(config) }, null, json ? 2 : 0)}\n`,
      );
      return 0;
    }
    if (command === 'init') {
      const profile = readOption(args, '--profile');
      const directory = readOption(args, '--dir') ?? '.';
      if (profile !== 'local-s3') {
        throw new Error(
          'Only --profile local-s3 is available. It writes a MinIO Compose file and does not start Docker.',
        );
      }
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'docker-compose.yml'),
        [
          '# Optional MinIO profile. The default test suite does not start Docker.',
          'services:',
          '  minio:',
          '    image: pgsty/silo:RELEASE.2026-11-12T00-00-00Z',
          '    command: server /data --console-address ":9001"',
          '    ports:',
          '      - "9000:9000"',
          '      - "9001:9001"',
          '    environment:',
          '      MINIO_ROOT_USER: local',
          '      MINIO_ROOT_PASSWORD: localpassword',
          '',
        ].join('\n'),
      );
      out.stdout(
        `${JSON.stringify({ ok: true, profile, directory, started: false })}\n`,
      );
      return 0;
    }
    if (command === 'cleanup') {
      const { createFiles } = await import('../server/index.js');
      const maxAge = Number(env.FILES_RETENTION_MAX_AGE_DAYS || '');
      const unused = Number(env.FILES_UNUSED_RETENTION_DAYS || '');
      const files = createFiles({
        ...(env.FILES_ENV === 'production' ||
        env.FILES_ENV === 'development' ||
        env.FILES_ENV === 'test'
          ? { env: env.FILES_ENV }
          : { env: 'test' as const }),
        storage: {
          root: env.FILES_STORAGE_ROOT || './.files/objects',
        },
        retention: {
          enabled: env.FILES_RETENTION_ENABLED === 'true',
          ...(Number.isFinite(maxAge) && maxAge > 0
            ? { maxAgeDays: maxAge }
            : {}),
          ...(Number.isFinite(unused) && unused > 0
            ? { unusedAfterDays: unused }
            : {}),
        },
      });
      try {
        const report = await files.retentionSweep(
          { dryRun: args.includes('--dry-run') },
          {
            principal: {
              id: 'cli',
              tenantId: readOption(args, '--tenant') ?? 'tenant',
            },
          },
        );
        out.stdout(`${JSON.stringify(report, null, json ? 2 : 0)}\n`);
      } finally {
        await files.close();
      }
      return 0;
    }
    if (command === 'migrate') {
      const { migrateHost } = await import('../metadata/migrate-host.js');
      const config = resolveConfig({}, env);
      await migrateHost(config);
      out.stdout(
        `${JSON.stringify({ ok: true, mode: config.metadata.mode })}\n`,
      );
      return 0;
    }
    if (command === 'doctor') {
      const report = await runDoctor({}, env);
      out.stdout(`${JSON.stringify(report, null, json ? 2 : 0)}\n`);
      return report.ok ? 0 : 1;
    }
    if (command === 'worker' && (sub === '--help' || args.includes('--help'))) {
      out.stdout(
        'filevora worker\nPoll the durable queue in this process. Does not spawn another worker.\n',
      );
      return 0;
    }
    out.stderr(`Unknown command. Run filevora --help.\n`);
    return 2;
  } catch (error) {
    printError(out, json || command === 'config', error);
    return 1;
  }
}

function readOption(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}
