import type { FilesOptions } from '../config/schema.js';
import { runWorker, type WorkerRunOptions } from './run.js';

export type { WorkerRunOptions as WorkerOptions };

/**
 * Poll the durable queue. Importing this module does not start a worker.
 * Pass a config file via `FILEVORA_CONFIG_PATH` or explicit options.
 */
export async function startWorker(
  options: WorkerRunOptions & { config?: FilesOptions } = {},
): Promise<void> {
  await runWorker({
    ...(options.options ? { options: options.options } : {}),
    ...(options.config ? { options: options.config } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.once ? { once: true } : {}),
  });
}

export { ensureEmbeddedWorker } from './supervisor.js';
export { runWorker };
