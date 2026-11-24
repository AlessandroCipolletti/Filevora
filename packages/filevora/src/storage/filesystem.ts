import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fail } from '../errors/error.js';
import type {
  ObjectMetadata,
  PutObjectInput,
  StorageCapabilities,
  StorageDriver,
  StoredObject,
} from '../types/index.js';

const KEY_PATTERN = /^[a-zA-Z0-9.][a-zA-Z0-9/_.-]{0,500}$/;

export function assertSafeKey(key: string): void {
  if (
    !KEY_PATTERN.test(key) ||
    key
      .split('/')
      .some((part) => part === '..' || part === '.' || part.length === 0)
  ) {
    throw fail('INVALID_STORAGE_KEY');
  }
}

function resolveInside(root: string, key: string): string {
  assertSafeKey(key);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, key);
  const relative = path.relative(resolvedRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative))
    throw fail('INVALID_STORAGE_KEY');
  return target;
}

async function refuseSymlink(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw fail('INVALID_STORAGE_KEY');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof Error && error.name === 'FileSdkError') throw error;
    throw error;
  }
}

/**
 * Local object store. Keys are opaque relative paths. User filenames are rejected
 * by `assertSafeKey` before they can escape `root`.
 */
export function createFilesystemStorage(root: string): StorageDriver {
  const resolvedRoot = path.resolve(root);

  async function ensureParent(target: string): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  }

  return {
    capabilities(): StorageCapabilities {
      return {
        driver: 'filesystem',
        multipart: false,
        presignedUpload: false,
        presignedDownload: false,
        rangeReads: true,
      };
    },
    async putObject(input: PutObjectInput): Promise<StoredObject> {
      const target = resolveInside(resolvedRoot, input.key);
      await refuseSymlink(target);
      await ensureParent(target);
      const temp = `${target}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
      const hash = createHash('sha256');
      let bytes = 0;
      const handle = await open(temp, 'wx', 0o600);
      try {
        if (input.body instanceof Uint8Array) {
          hash.update(input.body);
          bytes = input.body.byteLength;
          await handle.write(input.body);
        } else {
          for await (const chunk of input.body) {
            const view =
              chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            hash.update(view);
            bytes += view.byteLength;
            await handle.write(view);
          }
        }
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(temp, { force: true });
        throw error;
      }
      await handle.close();
      await rename(temp, target);
      const checksum = hash.digest('hex');
      return { key: input.key, bytes, etag: checksum, checksum };
    },
    async getObject(key: string): Promise<ReadableStream<Uint8Array>> {
      const target = resolveInside(resolvedRoot, key);
      await refuseSymlink(target);
      const stream = createReadStream(target);
      return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    },
    async headObject(key: string): Promise<ObjectMetadata | null> {
      const target = resolveInside(resolvedRoot, key);
      try {
        const info = await stat(target);
        if (info.isSymbolicLink() || !info.isFile()) return null;
        return { key, bytes: info.size, etag: null, contentType: null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw fail('STORAGE_UNAVAILABLE', {
          message: 'Could not stat the object.',
        });
      }
    },
    async deleteObject(key: string): Promise<void> {
      const target = resolveInside(resolvedRoot, key);
      await rm(target, { force: true });
    },
    async getObjectRange(
      key: string,
      start: number,
      end: number,
    ): Promise<Uint8Array> {
      return readObjectRange(resolvedRoot, key, start, end);
    },
    async list(
      prefix: string,
    ): Promise<
      Array<{ key: string; bytes: number; modifiedAt: string | null }>
    > {
      const slash = prefix.lastIndexOf('/');
      const dirKey = slash >= 0 ? prefix.slice(0, slash) : '';
      const startDir = dirKey
        ? resolveInside(resolvedRoot, dirKey)
        : resolvedRoot;
      const found: Array<{
        key: string;
        bytes: number;
        modifiedAt: string | null;
      }> = [];
      const walk = async (dir: string, keyPrefix: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const key = keyPrefix ? `${keyPrefix}/${entry.name}` : entry.name;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full, key);
            continue;
          }
          if (!entry.isFile() || (prefix && !key.startsWith(prefix))) continue;
          const info = await stat(full);
          found.push({
            key,
            bytes: info.size,
            modifiedAt: info.mtime.toISOString(),
          });
        }
      };
      await walk(startDir, dirKey);
      return found;
    },
    localPath(key: string): string {
      return resolveInside(resolvedRoot, key);
    },
    async close(): Promise<void> {
      // Local files have no client to release.
    },
  };
}

export async function readObjectRange(
  root: string,
  key: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const target = resolveInside(root, key);
  const handle = await open(target, 'r', 0o600);
  try {
    const length = end - start + 1;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function readPrefix(
  root: string,
  key: string,
  length = 64,
): Promise<Uint8Array> {
  const target = resolveInside(root, key);
  const handle = await open(target, 'r', 0o600);
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function concatFiles(
  root: string,
  keys: string[],
  destinationKey: string,
): Promise<{ bytes: number; checksum: string }> {
  const target = resolveInside(root, destinationKey);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
  const hash = createHash('sha256');
  let bytes = 0;
  const output = createWriteStream(temp, { flags: 'wx', mode: 0o600 });
  try {
    for (const key of keys) {
      const source = resolveInside(root, key);
      const input = createReadStream(source);
      for await (const chunk of input) {
        const view = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(view);
        bytes += view.byteLength;
        if (!output.write(view)) {
          await new Promise<void>((resolve) =>
            output.once('drain', () => resolve()),
          );
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.end(() => resolve());
      output.on('error', reject);
    });
  } catch (error) {
    output.destroy();
    await rm(temp, { force: true });
    throw fail('STORAGE_UNAVAILABLE', {
      message:
        error instanceof Error
          ? error.message
          : 'Could not assemble the upload.',
    });
  }
  await rename(temp, target);
  return { bytes, checksum: hash.digest('hex') };
}

export async function writeBytes(
  root: string,
  key: string,
  body: Uint8Array,
): Promise<void> {
  const target = resolveInside(root, key);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.partial-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.write(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, target);
}
