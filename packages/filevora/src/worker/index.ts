import type { FilesOptions } from '../config/schema.js';
import { fail } from '../errors/error.js';

export interface WorkerOptions {
  config?: FilesOptions;
}

/**
 * Process queued jobs. Importing this module does not start a worker.
 * The worker runtime arrives in M3. Calling it now fails closed.
 */
export async function runWorker(_options: WorkerOptions = {}): Promise<void> {
  throw fail('FEATURE_NOT_AVAILABLE', {
    message: 'The Filevora worker is not implemented yet.',
    context: { feature: 'worker' },
  });
}
