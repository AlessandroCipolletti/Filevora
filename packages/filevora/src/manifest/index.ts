import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { buildManifest, type ManifestHand } from './build.js';

function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as { name?: string };
      if (pkg.name === 'filevora') return dir;
    } catch {
      // keep walking
    }
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the filevora package root.');
}

/** Read the committed capability manifest shipped with the package. */
export function readManifest(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(packageRoot(), 'capabilities.json'), 'utf8'),
  ) as Record<string, unknown>;
}
