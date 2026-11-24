import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveConfig } from '../dist/config/load.js';
import { askGemini } from '../dist/descriptions/gemini.js';
import { clip, normaliseTags } from '../dist/descriptions/run.js';
import { FileSdkError } from '../dist/errors/error.js';
import { hostStatements } from '../dist/metadata/host-schema.js';
import { createFiles } from '../dist/server/index.js';
import {
  createTestFiles,
  sampleMp4,
  samplePdf,
  samplePng,
} from '../dist/testing/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

function wav(): Uint8Array {
  const data = Buffer.alloc(800);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

function geminiResponse() {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                description_long: 'A long calm landscape with a hill.',
                description_short: 'Calm landscape.',
                tags: [
                  { category: 'Subject', tag: 'Hill' },
                  { category: 'subject', tag: 'Hill' },
                  { category: 'emotion', tag: 'Calm' },
                  { category: 'purpose', tag: 'Landscape' },
                  { category: 'style', tag: 'Photo' },
                  { category: 'action', tag: 'Resting' },
                  { category: 'kind', tag: 'speech' },
                  { category: 'language', tag: 'en' },
                ],
              }),
            },
          ],
        },
      },
    ],
  });
}

function mockFetch(calls: string[]) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes(':generateContent')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        contents?: Array<{
          parts?: Array<{ inlineData?: { mimeType?: string } }>;
        }>;
      };
      const mime = body.contents?.[0]?.parts?.find(
        (part) => part.inlineData?.mimeType,
      )?.inlineData?.mimeType;
      calls.push(mime ?? url);
      assert.equal(String(init?.body ?? '').includes('test-key'), false);
      return new Response(geminiResponse(), { status: 200 });
    }
    calls.push(url);
    if (init?.method === 'DELETE') return new Response(null, { status: 200 });
    return new Response(
      JSON.stringify({
        file: { name: 'files/abc', uri: 'https://gemini.example/abc' },
      }),
      { status: 200 },
    );
  };
  return fetchImpl;
}

function stored(dir: string, fetchImpl: typeof fetch, describeAssets = false) {
  return createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
    gemini: {
      apiKey: 'test-key',
      fetchImpl,
      retryDelayMs: 0,
      describeAssets,
    },
  });
}

async function upload(
  files: ReturnType<typeof stored>,
  body: Uint8Array,
  filename: string,
  mimeType: string,
  describe?: boolean,
) {
  const session = await files.createUploadSession(
    {
      filename,
      mimeType,
      bytes: body.byteLength,
      ...(describe !== undefined ? { describe } : {}),
    },
    { principal },
  );
  await files.writePart(session.id, 1, body, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

test('lite mode refuses a description and a configured key', async () => {
  const files = createTestFiles();
  await assert.rejects(
    () =>
      files.files.createUploadSession(
        {
          filename: 'a.png',
          mimeType: 'image/png',
          bytes: 8,
          describe: true,
        },
        { principal: files.principal },
      ),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'DESCRIPTION_REQUIRES_DATABASE');
      assert.match(error.message, /FILEVORA_DATABASE_URL/);
      assert.match(
        String(error.resolution?.actions[0]?.description),
        /sqlite:\/\//,
      );
      return true;
    },
  );
  await files.close();
  assert.throws(
    () => resolveConfig({}, { FILEVORA_GEMINI_API_KEY: 'test-key' }),
    (error: unknown) => {
      assert.ok(error instanceof FileSdkError);
      assert.equal(error.code, 'DESCRIPTION_REQUIRES_DATABASE');
      return true;
    },
  );
});

test('describe true without a key names FILEVORA_GEMINI_API_KEY', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-describe-key-'));
  const files = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
  });
  try {
    await assert.rejects(
      () =>
        files.createUploadSession(
          {
            filename: 'a.png',
            mimeType: 'image/png',
            bytes: 8,
            describe: true,
          },
          { principal },
        ),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'DESCRIPTION_NOT_CONFIGURED');
        assert.match(error.message, /FILEVORA_GEMINI_API_KEY/);
        return true;
      },
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('describe overrides the default and stores tags', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-describe-ok-'));
  const calls: string[] = [];
  const files = stored(dir, mockFetch(calls), true);
  try {
    const skipped = await upload(
      files,
      samplePng(),
      'skip.png',
      'image/png',
      false,
    );
    assert.equal(skipped.description, undefined);
    assert.equal(calls.length, 0);
    const plain = stored(path.join(dir, 'plain'), mockFetch(calls), false);
    const forced = await upload(
      plain,
      samplePng(),
      'forced.png',
      'image/png',
      true,
    );
    assert.equal(forced.description?.status, 'done');
    await plain.close();
    const image = await upload(files, samplePng(), 'hill.png', 'image/png');
    assert.equal(calls.includes('image/webp'), true);
    assert.equal(image.description?.status, 'done');
    assert.equal(image.description?.short, 'Calm landscape.');
    assert.equal(image.processingState === 'failed', false);
    assert.ok(image.description?.tags.some((tag) => tag.tag === 'hill'));
    assert.equal(
      image.description?.tags.some((tag) => tag.category === 'kind'),
      false,
    );
    const found = await files.list({ tag: 'hill' }, { principal });
    assert.equal(
      found.items.some((item) => item.id === image.id),
      true,
    );
    const pdf = await upload(
      files,
      await samplePdf(),
      'note.pdf',
      'application/pdf',
      true,
    );
    assert.equal(pdf.description?.status, 'done');
    assert.equal(calls.includes('application/pdf'), true);
    assert.ok(pdf.description?.tags.some((tag) => tag.category === 'language'));
    assert.equal(
      pdf.description?.tags.some((tag) => tag.category === 'emotion'),
      false,
    );
    const audio = await upload(files, wav(), 'note.wav', 'audio/wav', true);
    assert.equal(audio.description?.status, 'done');
    assert.ok(audio.description?.tags.some((tag) => tag.category === 'kind'));
    assert.equal(calls.includes('audio/mp4'), true);
    const video = await upload(
      files,
      await sampleMp4(),
      'clip.mp4',
      'video/mp4',
      true,
    );
    assert.equal(video.description?.status, 'done');
    assert.ok(
      video.description?.tags.some((tag) => tag.category === 'emotion'),
    );
    assert.equal(calls.includes('video/mp4'), true);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a text file is described from its original bytes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-describe-csv-'));
  const calls: string[] = [];
  const files = stored(dir, mockFetch(calls), false);
  try {
    const csv = new TextEncoder().encode('name,city\nAda,Rome\n');
    const file = await upload(files, csv, 'people.csv', 'text/csv', true);
    assert.equal(file.description?.status, 'done');
    assert.equal(calls.includes('text/csv'), true);
    assert.ok(file.description?.tags.some((tag) => tag.category === 'subject'));
    assert.equal(
      file.description?.tags.some((tag) => tag.category === 'kind'),
      false,
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Gemini failure does not fail the asset', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-describe-fail-'));
  const fetchImpl: typeof fetch = async () =>
    new Response('no', { status: 400 });
  const files = stored(dir, fetchImpl);
  try {
    const image = await upload(
      files,
      samplePng(),
      'bad.png',
      'image/png',
      true,
    );
    assert.equal(image.uploadState, 'verified');
    assert.equal(image.description?.status, 'failed');
    assert.match(image.description?.error ?? '', /400/);
    assert.equal(image.processingState === 'failed', false);
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('large inputs use the Files API and delete the upload', async () => {
  const calls: string[] = [];
  const result = await askGemini({
    apiKey: 'test-key',
    model: 'gemini-3.5-flash-lite',
    mimeType: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3, 4, 5]),
    prompt: 'MEDIA: application/pdf',
    inlineMaxBytes: 2,
    retryDelayMs: 0,
    fetchImpl: mockFetch(calls),
  });
  assert.equal(result.descriptionShort, 'Calm landscape.');
  assert.ok(calls.some((url) => url.includes('/upload/')));
  assert.ok(calls.some((url) => url.includes(':generateContent')));
  assert.ok(calls.some((url) => url.endsWith('/files/abc')));
});

test('tag normalisation and host schemas include descriptions', () => {
  const tags = normaliseTags(
    [
      { category: 'KIND', tag: 'Speech' },
      { category: 'kind', tag: 'speech' },
      { category: 'emotion', tag: 'Joyful' },
    ],
    'audio/mpeg',
  );
  assert.deepEqual(tags, [{ category: 'kind', tag: 'speech' }]);
  assert.equal(clip('x'.repeat(4000), 3000).length <= 3000, true);
  assert.equal(clip('y'.repeat(500), 300).length <= 300, true);
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    const sql = hostStatements(dialect).join('\n');
    assert.match(sql, /filevora_asset_tags/);
    assert.match(sql, /description_long/);
    assert.match(sql, /description_short/);
  }
});
