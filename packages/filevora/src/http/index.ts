import { fail } from '../errors/error.js';
import type { Files } from '../server/index.js';
import type {
  FileOperation,
  FileRecord,
  Principal,
  UploadPolicy,
} from '../types/index.js';

export interface FilesHandlerOptions {
  files: Files;
  /** Required. Return null when the request has no application session. */
  authenticate: (request: Request) => Promise<Principal | null>;
  /** Required. Called for every operation except a signed content token fetch. */
  authorize: (input: {
    principal: Principal;
    operation: FileOperation;
    file?: FileRecord | null;
    request: Request;
  }) => Promise<boolean>;
  /** Required. Server-owned limits. Browser fields named ownerId or tenantId are ignored. */
  policy: (input: {
    principal: Principal;
    request: Request;
  }) => Promise<UploadPolicy>;
  /** Path prefix stripped before routing, for example `/api/files`. */
  basePath?: string;
}

/**
 * Framework-neutral HTTP adapter. The host authenticates the user.
 * Filevora does not issue accounts or API keys.
 *
 * Route implementations arrive in M1. This constructor only checks that the
 * host passed authorization hooks, so a handler cannot be created wide open.
 */
export function createFilesHandler(
  options: FilesHandlerOptions,
): (request: Request) => Promise<Response> {
  if (
    !options?.files ||
    typeof options.authenticate !== 'function' ||
    typeof options.authorize !== 'function'
  ) {
    throw fail('INVALID_CONFIG', {
      message:
        'createFilesHandler requires files, authenticate, and authorize.',
    });
  }
  if (typeof options.policy !== 'function') {
    throw fail('INVALID_CONFIG', {
      message: 'createFilesHandler requires a policy callback.',
    });
  }
  return async () => {
    throw fail('FEATURE_NOT_AVAILABLE', {
      message: 'The HTTP file routes are not implemented yet.',
      context: { feature: 'http-handler' },
    });
  };
}
