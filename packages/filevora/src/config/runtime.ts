import os from 'node:os';
import path from 'node:path';

export type RuntimeKind = 'long-running' | 'serverless' | 'edge';

/**
 * Detect a runtime that cannot keep a child worker alive.
 * `FILES_RUNTIME` overrides detection so tests and unusual hosts can be explicit.
 */
export function detectRuntime(env: NodeJS.ProcessEnv): RuntimeKind {
  const forced = env.FILES_RUNTIME;
  if (forced === 'long-running' || forced === 'serverless' || forced === 'edge')
    return forced;
  if (env.NEXT_RUNTIME === 'edge' || env.DENO_DEPLOYMENT_ID) return 'edge';
  if (
    env.AWS_LAMBDA_FUNCTION_NAME ||
    env.VERCEL ||
    env.FUNCTIONS_WORKER_RUNTIME ||
    env.AWS_EXECUTION_ENV?.includes('AWS_Lambda')
  ) {
    return 'serverless';
  }
  return 'long-running';
}

/** True when a path is the OS temp dir or `/tmp`, which disappears on many hosts. */
export function isEphemeralPath(target: string): boolean {
  const resolved = path.resolve(target);
  const tmp = path.resolve(os.tmpdir());
  if (resolved === tmp || resolved.startsWith(`${tmp}${path.sep}`)) return true;
  if (resolved === '/tmp' || resolved.startsWith(`/tmp${path.sep}`))
    return true;
  return false;
}
