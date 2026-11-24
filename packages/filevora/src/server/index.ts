import { type ResolvedConfig, resolveConfig } from '../config/load.js';
import type { FilesOptions } from '../config/schema.js';
import { FileService } from './service.js';

export type Files = FileService;

/**
 * Create a Filevora server instance.
 *
 * Configuration is validated immediately. SQLite and the object directory are
 * opened on the first file operation, not during construction, and no worker
 * is spawned.
 *
 * A Filevora account is not used and cannot be configured here.
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
export function createFiles(options: FilesOptions = {}): Files {
  return new FileService(resolveConfig(options, process.env));
}

export type { CreateSessionInput, RequestContext } from './service.js';
export {
  assetTransformSchema,
  type AssetTransform,
  type AssetTransformInput,
  type AssetTransformOperation,
} from '../transform/schema.js';
export type { FilesOptions, ResolvedConfig };
