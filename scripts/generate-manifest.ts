import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  type ManifestHand,
} from '../packages/filevora/dist/manifest/build.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hand = JSON.parse(
  readFileSync(path.join(root, 'docs/agents/capabilities.hand.json'), 'utf8'),
) as ManifestHand;
const text = `${JSON.stringify(buildManifest(hand), null, 2)}\n`;
const targets = [
  path.join(root, 'docs/agents/capabilities.json'),
  path.join(root, 'packages/filevora/capabilities.json'),
];
const check = process.argv.includes('--check');
if (check) {
  const stale = targets.filter((file) => readFileSync(file, 'utf8') !== text);
  if (stale.length > 0) {
    process.stderr.write(
      `Capability manifest is out of date: ${stale.join(', ')}. Run pnpm manifest.\n`,
    );
    process.exit(1);
  }
} else {
  for (const file of targets) writeFileSync(file, text);
}
