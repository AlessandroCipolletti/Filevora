import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { fail } from '../errors/error.js';
import type { StorageDriver } from '../types/index.js';
import { concatFiles, createFilesystemStorage } from './filesystem.js';

/** Filesystem or S3 driver for this config. Callers close it when they own it. */
export async function openStorage(
  storage: ResolvedConfig['storage'],
): Promise<StorageDriver> {
  if (storage.driver === 'filesystem') {
    mkdirSync(storage.root, { recursive: true, mode: 0o700 });
    return createFilesystemStorage(storage.root);
  }
  if (storage.driver === 's3') {
    const { createS3Storage } = await import('./s3.js');
    return createS3Storage(storage.s3);
  }
  throw fail('FEATURE_NOT_AVAILABLE', {
    message: 'That storage driver is not available.',
    context: { driver: storage.driver },
  });
}

export async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    total += step.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Local path for Sharp, FFmpeg, or PDFium.
 * Filesystem keys stay where they are. S3 objects are copied into a temp file.
 */
export async function materialize(
  storage: StorageDriver,
  key: string,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (storage.localPath) {
    return { path: storage.localPath(key), cleanup: async () => undefined };
  }
  const bytes = await readAll(await storage.getObject(key));
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-object-'));
  const file = path.join(dir, 'object');
  writeFileSync(file, bytes);
  return {
    path: file,
    cleanup: async () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Join part objects into one key. Filesystem storage still streams on disk. */
export async function concatStored(
  storage: StorageDriver,
  keys: string[],
  destinationKey: string,
): Promise<{ bytes: number; checksum: string }> {
  const first = keys[0];
  if (storage.localPath && first) {
    const absolute = storage.localPath(first);
    const suffix = first.split('/').join(path.sep);
    const root = absolute.slice(0, absolute.length - suffix.length);
    return concatFiles(root, keys, destinationKey);
  }
  const hash = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (const key of keys) {
    const part = await readAll(await storage.getObject(key));
    hash.update(part);
    chunks.push(part);
    bytes += part.byteLength;
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  await storage.putObject({ key: destinationKey, body });
  return { bytes, checksum: hash.digest('hex') };
}
