export interface ClientEnvOptions {
  resume: {
    strategy: 'indexeddb' | 'memory';
    persistBlob: 'never' | 'auto' | 'always';
    maxPersistedBytes: number;
  };
  progress: {
    channel: 'sse' | 'poll';
    pollMs: number;
  };
}

/**
 * Read host-app environment variables for the browser client.
 * Call this in the host process and pass the result into `createUploadClient`
 * and `upload()`. The published browser bundle does not read `process.env`.
 */
export function uploadClientOptionsFromEnv(
  env: Record<string, string | undefined>,
): ClientEnvOptions {
  const strategy =
    env.FILEVORA_RESUME_STRATEGY === 'memory' ? 'memory' : 'indexeddb';
  const persist = env.FILEVORA_RESUME_PERSIST_BLOB;
  const persistBlob =
    persist === 'never' || persist === 'always' || persist === 'auto'
      ? persist
      : 'auto';
  const max = Number(env.FILEVORA_RESUME_MAX_PERSISTED_BYTES ?? '33554432');
  const channel = env.FILEVORA_PROGRESS_CHANNEL === 'poll' ? 'poll' : 'sse';
  const poll = Number(env.FILEVORA_PROGRESS_POLL_MS ?? '1000');
  return {
    resume: {
      strategy,
      persistBlob,
      maxPersistedBytes: Number.isFinite(max) && max > 0 ? max : 33_554_432,
    },
    progress: {
      channel,
      pollMs: Number.isFinite(poll) && poll >= 50 ? poll : 1000,
    },
  };
}
