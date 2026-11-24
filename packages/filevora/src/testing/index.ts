import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FilesOptions } from '../config/schema.js';
import type { ProgressEvent } from '../progress/event.js';
import { signDeliveryToken } from '../security/delivery.js';
import { createFiles, type Files } from '../server/index.js';
import type { FileRecord, Principal } from '../types/index.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface TestFiles {
  files: Files;
  /** Filesystem object root. Lite mode stores its JSON cards under this directory. */
  root: string;
  principal: Principal;
  close(): Promise<void>;
}

/**
 * Filesystem storage, lite metadata, and synchronous processing.
 * Does not open Redis, S3, or a database server.
 * `processing.mode` is `sync`: upload and transform finish the job before they return.
 */
export function createTestFiles(overrides: FilesOptions = {}): TestFiles {
  const root =
    overrides.storage?.root ??
    mkdtempSync(path.join(tmpdir(), 'filevora-testing-'));
  const files = createFiles({
    env: 'test',
    upload: { chunkBytes: 64 * 1024 },
    ...overrides,
    storage: {
      ...overrides.storage,
      driver: 'filesystem',
      root,
    },
    processing: {
      spawn: 'never',
      ...overrides.processing,
      mode: 'sync',
    },
  });
  const principal = { id: 'user-test', tenantId: 'tenant-test' };
  return {
    files,
    root,
    principal,
    async close() {
      await files.close();
      if (!overrides.storage?.root)
        rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 1×1 PNG. Sharp accepts it for the image preset. */
export function samplePng(): Uint8Array {
  return new Uint8Array(PNG);
}

/** Two-page PDF. */
export async function samplePdf(): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.addPage([200, 200]);
  return new Uint8Array(await doc.save());
}

/**
 * One-second H.264 MP4 from the local `ffmpeg` binary.
 * Throws when `ffmpeg` is not on PATH.
 */
export async function sampleMp4(): Promise<Uint8Array> {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-sample-mp4-'));
  const file = path.join(dir, 'sample.mp4');
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=64x64:rate=5:duration=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        file,
      ],
      { stdio: 'ignore' },
    );
    if (result.status !== 0) {
      throw new Error(
        'ffmpeg did not produce a sample MP4. Install ffmpeg to use sampleMp4().',
      );
    }
    return new Uint8Array(readFileSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function uploadBytes(
  harness: TestFiles,
  body: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<FileRecord> {
  const session = await harness.files.createUploadSession(
    { filename, mimeType, bytes: body.byteLength },
    { principal: harness.principal },
  );
  await harness.files.writePart(session.id, 1, body, {
    principal: harness.principal,
  });
  return harness.files.completeUpload(
    session.id,
    {},
    { principal: harness.principal },
  );
}

/**
 * Read the same snapshot SSE would emit and check state plus version names.
 * Pass `baseUrl` so terminal success includes version URLs.
 */
export async function assertProgress(
  harness: TestFiles,
  assetId: string,
  expected: {
    state?: string;
    terminal?: boolean;
    phase?: ProgressEvent['phase'];
    versions?: string[];
  },
): Promise<ProgressEvent> {
  const event = await harness.files.processingSnapshot(
    assetId,
    { principal: harness.principal },
    { baseUrl: 'http://files.test' },
  );
  if (expected.state !== undefined) assert.equal(event.state, expected.state);
  if (expected.terminal !== undefined)
    assert.equal(event.terminal, expected.terminal);
  if (expected.phase !== undefined) assert.equal(event.phase, expected.phase);
  for (const name of expected.versions ?? []) {
    const version = event.versions?.[name];
    assert.ok(version, `missing version ${name}`);
    assert.equal(version.status, 'ready');
    assert.equal(typeof version.url, 'string');
  }
  return event;
}

/** Sign a `/content` URL with the test signing secret. */
export function signTestDeliveryUrl(
  assetId: string,
  options: {
    version?: string;
    expiresIn?: number;
    download?: string;
    ip?: string;
    salt?: string;
    secret?: string;
    baseUrl?: string;
  } = {},
): string {
  const exp = Math.floor(Date.now() / 1000) + (options.expiresIn ?? 900);
  const token = signDeliveryToken(
    options.secret ?? 'filevora-test-signing-secret',
    {
      assetId,
      version:
        options.version === '_original' || !options.version
          ? 'original'
          : options.version,
      exp,
      salt: options.salt ?? '',
      ...(options.download ? { download: options.download } : {}),
      ...(options.ip ? { ip: options.ip } : {}),
    },
  );
  const base = (options.baseUrl ?? 'http://files.test').replace(/\/$/, '');
  return `${base}/content/${token}`;
}
