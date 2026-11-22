import { type ResolvedConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';

/**
 * Server handle for Filevora.
 *
 * Constructing this object validates configuration and returns. It does not
 * open a database, touch storage, or spawn a worker. Later milestones add
 * upload and processing methods on this same object.
 *
 * @example
 * ```ts
 * import { createFiles } from 'filevora/server';
 *
 * const files = createFiles({
 *   storage: { driver: 'filesystem', root: './.files/objects' },
 *   metadata: { driver: 'sqlite', filename: './.files/metadata.sqlite' },
 * });
 * ```
 */
export interface Files {
  /** Resolved configuration with defaults applied. Treat this as immutable. */
  readonly config: ResolvedConfig;
  /** Release resources. Safe to call when nothing has been opened yet. */
  close(): Promise<void>;
}

/**
 * Create a Filevora server instance.
 * A Filevora account is not used and cannot be configured here.
 */
export function createFiles(options: FilesOptions = {}): Files {
  const config = resolveConfig(options, process.env);
  return {
    config,
    async close() {
      // M0 opens nothing. Later milestones close SQLite, pools, and child workers here.
    },
  };
}

export type { FilesOptions, ResolvedConfig };
