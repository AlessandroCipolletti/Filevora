import process from 'node:process';
import {
  DockerError,
  checkDocker,
  installTeardownSignals,
  redisPreflight,
  runTestsInDocker,
  servicesDownSync,
  servicesUp,
} from './docker-services.ts';
import { TEST_ENV } from './test-env.ts';

const usage = `Usage: node scripts/test-services.ts <up|down|test|preflight>

  up         Start Redis, MinIO, Postgres, and MySQL in Docker and wait until healthy (pnpm services:up)
  down       Stop them and remove their data (pnpm services:down)
  test       up, run pnpm test with every service env var set, then always down (pnpm test:docker)
  preflight  Fail fast with a clear message when Redis is not configured or not reachable`;

async function main(): Promise<number> {
  const command = process.argv[2];
  switch (command) {
    case 'up':
      servicesUp();
      process.stdout.write(
        `\nTo run tests against these services by hand, export:\n${Object.entries(
          TEST_ENV,
        )
          .map(([key, value]) => `  ${key}=${value}`)
          .join('\n')}\nStop and wipe them with: pnpm services:down\n`,
      );
      return 0;
    case 'down':
      checkDocker();
      servicesDownSync();
      return 0;
    case 'test':
      installTeardownSignals();
      return runTestsInDocker();
    case 'preflight': {
      const problem = await redisPreflight(process.env);
      if (problem) {
        process.stderr.write(`\ntest preflight: ${problem}\n`);
        return 1;
      }
      return 0;
    }
    default:
      process.stderr.write(`${usage}\n`);
      return command === undefined || command === '--help' ? 0 : 1;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `\n${error instanceof DockerError ? 'docker' : 'test-services'}: ${message}\n`,
  );
  process.exitCode = 1;
}
