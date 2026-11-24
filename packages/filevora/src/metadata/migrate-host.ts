import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import { openBackend } from './backend.js';

/** Apply `filevora_assets` on the host database. Lite mode has nothing to migrate. */
export async function migrateHost(config: ResolvedConfig): Promise<void> {
  if (config.metadata.mode !== 'stored') {
    throw fail('FEATURE_REQUIRES_STORED_MODE', {
      message: 'filevora migrate requires stored metadata mode.',
      context: { mode: config.metadata.mode },
    });
  }
  const sql = await openBackend(config);
  await sql.close();
}
