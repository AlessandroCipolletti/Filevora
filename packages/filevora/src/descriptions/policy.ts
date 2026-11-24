import { fail } from '../errors/error.js';
import {
  DESCRIPTION_DATABASE_MESSAGE,
  DESCRIPTION_KEY_MESSAGE,
} from './messages.js';

export { DESCRIPTION_DATABASE_MESSAGE, DESCRIPTION_KEY_MESSAGE };

/** True when this asset should be described. Throws when the request cannot be stored. */
export function describeIntent(
  input: boolean | undefined,
  config: {
    metadata: { mode: string };
    gemini: { apiKey: string; describeAssets: boolean };
  },
): boolean {
  if (input === false) return false;
  const wanted = input === true || config.gemini.describeAssets;
  if (!wanted) return false;
  if (config.metadata.mode !== 'stored') {
    throw fail('DESCRIPTION_REQUIRES_DATABASE', {
      message: DESCRIPTION_DATABASE_MESSAGE,
    });
  }
  if (!config.gemini.apiKey) {
    throw fail('DESCRIPTION_NOT_CONFIGURED', {
      message: DESCRIPTION_KEY_MESSAGE,
    });
  }
  return true;
}
