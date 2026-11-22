import { fail } from '../errors/error.js';

export interface UploadClientOptions {
  /** Host route where `createFilesHandler` is mounted, for example `/api/files`. */
  endpoint: string;
}

/**
 * Browser upload helper.
 *
 * This module is safe to bundle for the browser. It does not import Node,
 * storage credentials, or the future managed API key.
 *
 * The upload implementation arrives in M2. Calling this in M0 fails with
 * `FEATURE_NOT_AVAILABLE` rather than pretending an upload started.
 */
export interface UploadClient {
  readonly endpoint: string;
}

/** Create a browser upload client. Does not read server environment variables. */
export function createUploadClient(options: UploadClientOptions): UploadClient {
  if (!options?.endpoint || typeof options.endpoint !== 'string') {
    throw fail('INVALID_CONFIG', {
      message: 'createUploadClient requires an endpoint.',
    });
  }
  throw fail('FEATURE_NOT_AVAILABLE', {
    message: 'The browser upload client is not implemented yet.',
    context: { feature: 'client-upload' },
  });
}
