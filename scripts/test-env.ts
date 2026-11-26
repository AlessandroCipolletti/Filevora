/**
 * The one place that says where the Docker test services listen and which
 * environment variables the networked tests read. docker-compose.test.yml
 * publishes these ports; docker-services.test.ts checks the two agree.
 * Credentials are the throwaway ones from .github/workflows/ci.yml.
 */
export const SERVICE_PORTS = {
  redis: 16379,
  minio: 19000,
  postgres: 15432,
  mysql: 13306,
} as const;

export const TEST_ENV: Readonly<Record<string, string>> = {
  REDIS_URL: `redis://127.0.0.1:${SERVICE_PORTS.redis}`,
  FILEVORA_S3_ENDPOINT: `http://127.0.0.1:${SERVICE_PORTS.minio}`,
  FILEVORA_S3_BUCKET: 'filevora-ci',
  FILEVORA_S3_ACCESS_KEY_ID: 'local',
  FILEVORA_S3_SECRET_ACCESS_KEY: 'localpassword',
  FILEVORA_S3_REGION: 'us-east-1',
  FILEVORA_POSTGRES_URL: `postgres://filevora:filevora@127.0.0.1:${SERVICE_PORTS.postgres}/filevora`,
  FILEVORA_MYSQL_URL: `mysql://root:filevora@127.0.0.1:${SERVICE_PORTS.mysql}/filevora`,
};

/** Variables removed so a stray value cannot override the Docker services. */
export const SCRUBBED_ENV_KEYS: readonly string[] = [
  'FILES_REDIS_URL',
  'FILEVORA_DATABASE_URL',
];

export const COMPOSE_FILE = 'docker-compose.test.yml';
export const COMPOSE_PROJECT = 'filevora-test';

export function testEnv(
  base: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of SCRUBBED_ENV_KEYS) delete env[key];
  return { ...env, ...TEST_ENV };
}
