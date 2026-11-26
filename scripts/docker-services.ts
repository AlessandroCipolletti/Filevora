import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { COMPOSE_FILE, COMPOSE_PROJECT, testEnv } from './test-env.ts';

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

export class DockerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DockerError';
  }
}

export interface DockerProbe {
  versionOk: boolean;
  versionError?: string;
  infoOk: boolean;
  infoOutput: string;
  composeOk: boolean;
}

/** Turns the three probe results into one actionable message, or undefined when Docker is fine. */
export function describeDockerProblem(
  probe: DockerProbe,
  platform: string = process.platform,
): string | undefined {
  if (!probe.versionOk) {
    const missing = /ENOENT/.test(probe.versionError ?? '');
    return missing
      ? 'Docker is not installed (the "docker" command was not found). Install Docker Desktop or Docker Engine, then run this again. The tests need Redis, MinIO, Postgres, and MySQL, which this repo starts with Docker.'
      : `Could not run "docker --version": ${probe.versionError ?? 'unknown error'}`;
  }
  if (!probe.infoOk) {
    const start =
      platform === 'darwin' || platform === 'win32'
        ? 'Start Docker Desktop and wait until it says it is running'
        : 'Start the Docker daemon (for example "sudo systemctl start docker")';
    const detail = probe.infoOutput.trim().split('\n').slice(-1)[0] ?? '';
    return `Docker is installed but not running. ${start}, then run this again.${detail ? `\n  docker said: ${detail}` : ''}`;
  }
  if (!probe.composeOk) {
    return 'Docker Compose v2 is missing ("docker compose version" failed). Update Docker Desktop, or install the docker-compose-plugin package.';
  }
  return undefined;
}

export function checkDocker(): void {
  const version = spawnSync('docker', ['--version'], { encoding: 'utf8' });
  const info = spawnSync('docker', ['info'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const compose = spawnSync('docker', ['compose', 'version'], {
    encoding: 'utf8',
  });
  const problem = describeDockerProblem({
    versionOk: !version.error && version.status === 0,
    versionError: version.error?.message ?? version.stderr,
    infoOk: !info.error && info.status === 0,
    infoOutput: `${info.stderr ?? ''}${info.error?.message ?? ''}`,
    composeOk: !compose.error && compose.status === 0,
  });
  if (problem) throw new DockerError(problem);
}

const COMPOSE_BASE = ['compose', '-p', COMPOSE_PROJECT, '-f', COMPOSE_FILE];

let servicesStarted = false;
let activeChild: ChildProcess | undefined;

type Log = (message: string) => void;

const defaultLog: Log = (message) => process.stdout.write(`${message}\n`);

function compose(
  args: string[],
  opts: { quiet?: boolean } = {},
): { status: number } {
  const result = spawnSync('docker', [...COMPOSE_BASE, ...args], {
    cwd: repoRoot,
    stdio: opts.quiet ? 'ignore' : 'inherit',
  });
  if (result.error) {
    throw new DockerError(`Could not run docker: ${result.error.message}`);
  }
  return { status: result.status ?? 1 };
}

export function servicesUp(log: Log = defaultLog): void {
  checkDocker();
  log(
    'Starting Redis, MinIO, Postgres, and MySQL with Docker (first run pulls images)...',
  );
  servicesStarted = true;
  const up = compose(['up', '-d', '--wait', '--wait-timeout', '240']);
  if (up.status !== 0) {
    compose(['ps', '-a'], {});
    compose(['logs', '--tail', '40']);
    throw new DockerError(
      `docker compose up failed (exit ${up.status}). A host port may be taken (the services use 16379, 19000, 15432, and 13306), or a container was unhealthy. Logs are above.`,
    );
  }
  log('Services are healthy.');
}

export function servicesDownSync(log: Log = defaultLog): void {
  servicesStarted = false;
  log('Stopping the Docker test services and removing their data...');
  try {
    const down = compose(['down', '-v', '--remove-orphans', '--timeout', '5']);
    if (down.status !== 0) {
      log(
        `warning: docker compose down exited ${down.status}. Run "pnpm services:down" to retry.`,
      );
    }
  } catch (error) {
    log(
      `warning: could not stop the services: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Runs `pnpm test` against the Docker services and returns its exit code. Always tears the services down. */
export async function runTestsInDocker(
  opts: {
    env?: NodeJS.ProcessEnv;
    log?: Log;
    command?: [string, string[]];
  } = {},
): Promise<number> {
  const log = opts.log ?? defaultLog;
  const [command, args] = opts.command ?? ['pnpm', ['test']];
  const env = testEnv(opts.env ?? process.env);
  try {
    servicesUp(log);
    log(`Running "${[command, ...args].join(' ')}" with the Docker test env.`);
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      activeChild = child;
      child.once('error', reject);
      child.once('close', (code, signal) => {
        activeChild = undefined;
        resolve(code ?? (signal ? 130 : 1));
      });
    });
  } finally {
    activeChild = undefined;
    servicesDownSync(log);
  }
}

/** Kills the test child and removes the services. Safe to call twice. */
export function emergencyStop(log: Log = defaultLog): void {
  if (activeChild && activeChild.exitCode === null) {
    activeChild.kill('SIGTERM');
  }
  activeChild = undefined;
  if (servicesStarted) servicesDownSync(log);
}

export function installTeardownSignals(
  onExit: () => void = () => undefined,
  log: Log = defaultLog,
): void {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
      log(`\nReceived ${signal}. Cleaning up.`);
      try {
        emergencyStop(log);
      } finally {
        onExit();
        process.exit(130);
      }
    });
  }
}

export interface RedisTarget {
  host: string;
  port: number;
}

export function parseRedisUrl(url: string): RedisTarget | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      return undefined;
    }
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number(parsed.port) : 6379,
    };
  } catch {
    return undefined;
  }
}

function canConnect(target: RedisTarget, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const DOCKER_HINT =
  'Run the whole suite with its services in Docker: pnpm test:docker\nOr start your own Redis and set REDIS_URL (for example REDIS_URL=redis://127.0.0.1:6379 pnpm test).';

/** Returns an error message when the tests cannot run, or undefined when Redis is reachable. */
export async function redisPreflight(
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = 2000,
): Promise<string | undefined> {
  const url = env.REDIS_URL || env.FILES_REDIS_URL;
  if (!url) {
    return `The tests need Redis, but REDIS_URL is not set.\n${DOCKER_HINT}`;
  }
  const target = parseRedisUrl(url);
  if (!target) {
    return `REDIS_URL is not a redis:// URL.\n${DOCKER_HINT}`;
  }
  if (!(await canConnect(target, timeoutMs))) {
    return `The tests need Redis, but nothing answered at ${target.host}:${target.port} (from REDIS_URL).\n${DOCKER_HINT}`;
  }
  return undefined;
}
