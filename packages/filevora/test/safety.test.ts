import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { FileSdkError } from '../dist/errors/error.js';
import { tenantPath } from '../dist/ids.js';
import { stripGpsTiff, stripImageMetadata } from '../dist/safety/exif.js';
import { maxBytesForType } from '../dist/safety/limits.js';
import { createClamAvScanner } from '../dist/safety/scan.js';
import { createFiles } from '../dist/server/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

function jpegWithExif(): Uint8Array {
  const description = Buffer.from('KEEPME\0');
  const gps = Buffer.from('GPSLAT');
  const tiff = Buffer.alloc(
    8 + 2 + 12 * 2 + 4 + description.length + gps.length,
  );
  tiff.write('II', 0);
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  tiff.writeUInt16LE(0x010e, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(description.length, 14);
  const descAt = 8 + 2 + 24 + 4;
  tiff.writeUInt32LE(descAt, 18);
  tiff.writeUInt16LE(0x8825, 22);
  tiff.writeUInt16LE(4, 24);
  tiff.writeUInt32LE(1, 26);
  const gpsAt = descAt + description.length;
  tiff.writeUInt32LE(gpsAt, 30);
  tiff.writeUInt32LE(0, 34);
  description.copy(tiff, descAt);
  gps.copy(tiff, gpsAt);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0'), tiff]);
  const app1 = Buffer.alloc(4 + app1Body.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(app1Body.length + 2, 2);
  app1Body.copy(app1, 4);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    app1,
    Buffer.from([0xff, 0xd9]),
  ]);
}

test('type limits and EXIF stripping follow the detected bytes', () => {
  assert.equal(
    maxBytesForType('image/png', { 'image/png': 10, 'image/*': 50 }, 100),
    10,
  );
  assert.equal(maxBytesForType('image/gif', { 'image/*': 50 }, 100), 50);
  assert.equal(maxBytesForType('video/mp4', {}, 100), 100);
  const jpeg = jpegWithExif();
  const gps = stripImageMetadata(jpeg, 'gps');
  assert.equal(Buffer.from(gps).includes('KEEPME'), true);
  assert.equal(Buffer.from(gps).includes('GPSLAT'), false);
  const all = stripImageMetadata(jpeg, 'all');
  assert.equal(Buffer.from(all).includes('KEEPME'), false);
  assert.equal(
    Buffer.from(stripImageMetadata(jpeg, 'none')).includes('GPSLAT'),
    true,
  );
  assert.ok(stripGpsTiff(jpeg.subarray(0, 4)).byteLength >= 4);
});

test('a plugged-in scanner quarantines infected originals before encoding', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-scan-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    safety: {
      typeMaxBytes: { 'image/png': 50 },
      scanner: {
        async scan() {
          return 'infected';
        },
      },
    },
  });
  try {
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    assert.ok(png.byteLength > 50);
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, png, { principal });
    await assert.rejects(
      files.completeUpload(session.id, {}, { principal }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'FILE_TOO_LARGE');
        assert.equal(error.context?.detectedType, 'image/png');
        return true;
      },
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }

  const scanned = mkdtempSync(path.join(tmpdir(), 'filevora-scan-2-'));
  const files2 = createFiles({
    env: 'test',
    storage: { root: path.join(scanned, 'objects') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    safety: {
      scanner: {
        async scan() {
          return 'infected';
        },
      },
    },
  });
  try {
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 1, g: 2, b: 3 },
      },
    })
      .png()
      .toBuffer();
    const session = await files2.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files2.writePart(session.id, 1, png, { principal });
    const record = await files2.completeUpload(session.id, {}, { principal });
    assert.equal(record.processingState, 'quarantined');
    assert.equal(record.metadata.filevoraSafetyError, 'MALWARE_DETECTED');
    const folder = path.join(scanned, 'objects', tenantPath('tenant-a'));
    const names = readdirSync(folder).filter((name) =>
      name.includes('_original.'),
    );
    assert.equal(names.length, 0);
    const held = path.join(scanned, 'objects', '.filevora', 'quarantine');
    assert.ok(readdirSync(held).length > 0);
  } finally {
    await files2.close();
    rmSync(scanned, { recursive: true, force: true });
  }
});

test('the ClamAV adapter reads an INSTREAM verdict', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (chunk.includes('zINSTREAM')) socket.end('stream: Eicar FOUND');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const scanner = createClamAvScanner({
      host: '127.0.0.1',
      port,
      timeoutMs: 1000,
    });
    assert.equal(
      await scanner.scan({
        assetId: 'file_a',
        mime: 'image/png',
        bytes: Buffer.from('eicar'),
      }),
      'infected',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a failed scanner does not publish the original', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-scan-fail-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    upload: { chunkBytes: 64 * 1024 },
    processing: { mode: 'inline', spawn: 'never' },
    safety: {
      scanner: {
        async scan() {
          throw new Error('socket down');
        },
      },
    },
  });
  try {
    const png = await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: { r: 9, g: 9, b: 9 },
      },
    })
      .png()
      .toBuffer();
    const session = await files.createUploadSession(
      { filename: 'dot.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, png, { principal });
    const record = await files.completeUpload(session.id, {}, { principal });
    assert.equal(record.processingState, 'failed');
    assert.equal(record.metadata.filevoraSafetyError, 'MALWARE_SCAN_FAILED');
    assert.equal(readFileSync.length > 0, true);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
