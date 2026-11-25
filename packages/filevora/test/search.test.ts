import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createUploadClient } from '../dist/client/index.js';
import { resolveConfig } from '../dist/config/load.js';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import { hostStatements } from '../dist/metadata/host-schema.js';
import { handleMcpMessage } from '../dist/mcp/stdio.js';
import { createFiles } from '../dist/server/index.js';
import {
  decodeSearchCursor,
  encodeSearchCursor,
  queryFingerprint,
  scoreToMicros,
} from '../dist/search/cursor.js';
import {
  buildCanonicalEmbeddingText,
  embedDocument,
  embedText,
  normalizeToFloat32Bytes,
  toFloat32,
} from '../dist/search/embed.js';
import {
  EMBED_FILE_LIMITS,
  convertAudioToMp3,
  prepareEmbeddingFile,
} from '../dist/search/embed-file.js';
import { QueryVectorCache } from '../dist/search/query-cache.js';
import { dot, rankEmbeddings } from '../dist/search/rank.js';
import { parseListQuery } from '../dist/server/list-query.js';
import { createTestFiles } from '../dist/testing/index.js';
import {
  DIMENSIONS,
  createMockGemini,
  mockEmbeddingValues,
  openSearchFiles,
  type MockGemini,
} from './search-helpers.ts';

const principal = { id: 'user-a', tenantId: 'tenant-a' };

async function uploadText(
  files: ReturnType<typeof createFiles>,
  filename: string,
  content: string,
  extra: { describe?: boolean } = {},
) {
  const body = new TextEncoder().encode(content);
  const session = await files.createUploadSession(
    {
      filename,
      mimeType: 'text/csv',
      bytes: body.byteLength,
      describe: extra.describe ?? true,
    },
    { principal },
  );
  await files.writePart(session.id, 1, body, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

function withFiles(
  name: string,
  run: (
    context: {
      dir: string;
      gemini: MockGemini;
      files: ReturnType<typeof createFiles>;
    },
    t: TestContext,
  ) => Promise<void>,
  overrides: Parameters<typeof openSearchFiles>[2] = {},
) {
  return test(name, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'filevora-search-'));
    const gemini = createMockGemini();
    const files = openSearchFiles(dir, gemini, overrides);
    try {
      await run({ dir, gemini, files }, t);
    } finally {
      await files.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

function embeddingRows(dir: string) {
  const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
  try {
    return db
      .prepare(
        'SELECT asset_id, model, dimensions, source, content_hash, length(embedding) AS bytes FROM filevora_asset_embeddings ORDER BY asset_id',
      )
      .all() as Array<{
      asset_id: string;
      model: string;
      dimensions: number;
      source: string;
      content_hash: string;
      bytes: number;
    }>;
  } finally {
    db.close();
  }
}

async function searchError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FileSdkError, String(error));
    return error;
  }
  assert.fail('Expected the search to be rejected.');
}

test('normalizeToFloat32Bytes returns a unit little-endian vector and rejects bad input', () => {
  const bytes = normalizeToFloat32Bytes([3, 4, 0, 0], 4);
  assert.equal(bytes.byteLength, 16);
  const view = new DataView(bytes.buffer);
  assert.ok(Math.abs(view.getFloat32(0, true) - 0.6) < 1e-6);
  assert.ok(Math.abs(view.getFloat32(4, true) - 0.8) < 1e-6);
  const decoded = toFloat32(bytes);
  assert.ok(Math.abs(dot(decoded, decoded, 4) - 1) < 1e-6);
  const shifted = new Uint8Array(bytes.byteLength + 1);
  shifted.set(bytes, 1);
  assert.deepEqual(
    [...toFloat32(shifted.subarray(1))],
    [...toFloat32(bytes)],
    'a misaligned view is copied',
  );
  for (const values of [
    [1, 2, 3],
    [1, 2, 3, Number.NaN],
    [0, 0, 0, 0],
  ]) {
    assert.throws(
      () => normalizeToFloat32Bytes(values, 4),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'EMBEDDING_UNAVAILABLE',
    );
  }
});

test('embedText surfaces Google errors and only retries 429 and 5xx', async () => {
  const apiKey = 'AIzaSyTestKeyThatMustNeverLeak0123456789';
  const cases = [
    {
      status: 400,
      body: {
        error: {
          code: 400,
          message: `API key not valid. Please pass a valid API key. ${apiKey}`,
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
            },
          ],
        },
      },
      retryable: false,
      calls: 1,
      hint: /FILEVORA_GEMINI_API_KEY/,
    },
    {
      status: 402,
      body: {
        error: {
          code: 402,
          message: 'Your prepayment credits are depleted.',
          status: 'PAYMENT_REQUIRED',
        },
      },
      retryable: false,
      calls: 1,
      hint: /billing/i,
    },
    {
      status: 429,
      body: {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
      retryable: true,
      calls: 3,
      hint: /Retry with backoff/,
    },
  ];
  for (const entry of cases) {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(entry.body), {
        status: entry.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    let caught: unknown;
    try {
      await embedText(
        {
          apiKey,
          embeddingModel: 'gemini-embedding-2',
          embeddingDimensions: DIMENSIONS,
          retryDelayMs: 0,
          fetchImpl,
        },
        { text: 'dogs', task: 'RETRIEVAL_QUERY' },
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof FileSdkError, String(caught));
    assert.equal(caught.code, 'EMBEDDING_UNAVAILABLE');
    assert.equal(
      caught.retryable,
      entry.retryable,
      `retryable ${entry.status}`,
    );
    assert.equal(requests.length, entry.calls, `attempts ${entry.status}`);
    assert.match(
      caught.message,
      new RegExp(`${entry.status} ${entry.body.error.status}`),
    );
    assert.match(caught.message, entry.hint);
    assert.equal(caught.context?.geminiHttpStatus, entry.status);
    assert.equal(caught.context?.geminiStatus, entry.body.error.status);
    assert.match(
      String(caught.context?.geminiMessage),
      new RegExp(entry.body.error.message.slice(0, 12)),
    );
    const serialized = JSON.stringify(caught.toJSON()) + caught.message;
    assert.equal(serialized.includes(apiKey), false, 'key never leaks');
    assert.equal(serialized.includes('generativelanguage'), false, 'no URL');
    assert.equal(requests[0]?.url.includes(apiKey), false);
  }
});

test('embedText sends the documented gemini-embedding-2 request', async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(
      JSON.stringify({ embedding: { values: mockEmbeddingValues('x') } }),
      { status: 200 },
    );
  };
  for (const embeddingModel of [
    'gemini-embedding-2',
    'models/gemini-embedding-2',
  ]) {
    requests.length = 0;
    await embedText(
      {
        apiKey: 'k',
        embeddingModel,
        embeddingDimensions: DIMENSIONS,
        retryDelayMs: 0,
        fetchImpl,
      },
      { text: 'A dog.', task: 'RETRIEVAL_DOCUMENT', title: 'dog.txt' },
    );
    assert.equal(
      requests[0]?.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent',
    );
    assert.deepEqual(requests[0]?.body, {
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: 'title: dog.txt | text: A dog.' }] },
      output_dimensionality: DIMENSIONS,
    });
  }
});

test('a file and its description go in one request as two parts', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({ embedding: { values: mockEmbeddingValues('x') } }),
      { status: 200 },
    );
  };
  const config = {
    apiKey: 'k',
    embeddingModel: 'gemini-embedding-2',
    embeddingDimensions: DIMENSIONS,
    retryDelayMs: 0,
    fetchImpl,
  };
  const result = await embedDocument(config, {
    text: 'A dog on a beach.',
    title: 'dog.jpg',
    file: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' },
  });
  assert.equal(result.source, 'file+description');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    model: 'models/gemini-embedding-2',
    content: {
      parts: [
        { text: 'A dog on a beach.' },
        { inline_data: { mime_type: 'image/jpeg', data: 'AQID' } },
      ],
    },
    output_dimensionality: DIMENSIONS,
  });
  assert.equal('taskType' in requests[0]!, false);
});

test('embedDocument falls back to the description when Google rejects the file', async () => {
  const requests: Array<{ parts: number }> = [];
  const logs: string[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      content: { parts: unknown[] };
    };
    requests.push({ parts: body.content.parts.length });
    if (body.content.parts.length > 1) {
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: 'INVALID_ARGUMENT',
            message: 'bad media',
          },
        }),
        { status: 400 },
      );
    }
    return new Response(
      JSON.stringify({ embedding: { values: mockEmbeddingValues('x') } }),
      { status: 200 },
    );
  };
  const result = await embedDocument(
    {
      apiKey: 'k',
      embeddingModel: 'gemini-embedding-2',
      embeddingDimensions: DIMENSIONS,
      retryDelayMs: 0,
      fetchImpl,
    },
    {
      text: 'A clip.',
      file: { bytes: new Uint8Array([1]), mime: 'video/mp4' },
    },
    (message) => logs.push(message),
  );
  assert.equal(result.source, 'description');
  assert.deepEqual(requests, [{ parts: 2 }, { parts: 1 }]);
  assert.match(logs[0] ?? '', /rejected the video\/mp4 file/);
});

test('dot matches a plain loop for any length', () => {
  for (const length of [1, 3, 4, 7, 768]) {
    const left = Float32Array.from({ length }, (_, i) => Math.sin(i + 1));
    const right = Float32Array.from({ length }, (_, i) => Math.cos(i * 2));
    let expected = 0;
    for (let i = 0; i < length; i += 1) expected += left[i]! * right[i]!;
    assert.ok(Math.abs(dot(left, right, length) - expected) < 1e-4);
  }
});

test('canonical embedding text is deterministic and ignores tag order', () => {
  const base = {
    assetType: 'image',
    mime: 'image/png',
    originalName: ' dog.png ',
    descriptionShort: 'A dog.',
    descriptionLong: 'A dog plays on a beach.',
  };
  const one = buildCanonicalEmbeddingText({
    ...base,
    tags: [
      { category: 'subject', tag: 'dog' },
      { category: 'emotion', tag: 'joyful' },
      { category: 'subject', tag: 'beach' },
    ],
  });
  const two = buildCanonicalEmbeddingText({
    ...base,
    tags: [
      { category: 'subject', tag: 'beach' },
      { category: 'subject', tag: 'dog' },
      { category: 'emotion', tag: 'joyful' },
    ],
  });
  assert.deepEqual(one, two);
  assert.equal(one.title, 'dog.png');
  assert.match(one.text, /Tags: emotion: joyful; subject: beach, dog/);
  assert.equal(one.contentHash.length, 64);
});

test('the query vector cache evicts by size and by age', () => {
  let now = 1_000;
  const cache = new QueryVectorCache({
    maxEntries: 2,
    ttlMs: 100,
    now: () => now,
  });
  const vector = new Uint8Array([1]);
  cache.set('a', vector);
  cache.set('b', vector);
  assert.ok(cache.get('a'));
  cache.set('c', vector);
  assert.equal(cache.get('b'), undefined, 'least recently used goes first');
  assert.ok(cache.get('a'));
  now += 101;
  assert.equal(cache.get('a'), undefined, 'expired entries are dropped');
  assert.equal(QueryVectorCache.key('m', 768, 'q'), 'm:768:q');
});

test('search cursors round-trip and reject a different query or tampering', () => {
  const qh = queryFingerprint({ query: 'dogs', minScore: 500_000 });
  const cursor = encodeSearchCursor({ v: 1, s: 683_000, id: 'f_1', n: 7, qh });
  assert.deepEqual(decodeSearchCursor(cursor, qh), {
    v: 1,
    s: 683_000,
    id: 'f_1',
    n: 7,
    qh,
  });
  assert.equal(
    queryFingerprint({ minScore: 500_000, query: 'dogs' }),
    qh,
    'key order does not matter',
  );
  const other = queryFingerprint({ query: 'cats', minScore: 500_000 });
  for (const bad of [cursor, 'not-a-cursor', '', 'e30']) {
    assert.throws(
      () => decodeSearchCursor(bad, other),
      (error: unknown) =>
        error instanceof FileSdkError && error.code === 'SEARCH_QUERY_INVALID',
    );
  }
  assert.equal(scoreToMicros(0.6830004), 683_000);
  assert.equal(scoreToMicros(2), 1_000_000);
});

test('embedText sends the documented request and never puts the key in the body', async () => {
  const requests: Array<{ url: string; headers: unknown; body: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({
      url: String(input),
      headers: init?.headers ?? {},
      body: String(init?.body),
    });
    return new Response(
      JSON.stringify({ embedding: { values: [3, 4, 0, 0] } }),
      { status: 200 },
    );
  };
  const config = {
    apiKey: 'secret-key',
    embeddingModel: 'gemini-embedding-2',
    embeddingDimensions: 4,
    retryDelayMs: 0,
    fetchImpl,
  };
  await embedText(config, {
    text: 'A dog.',
    task: 'RETRIEVAL_DOCUMENT',
    title: 'dog.png',
  });
  await embedText(config, { text: 'cani', task: 'RETRIEVAL_QUERY' });
  await embedText(
    { ...config, embeddingModel: 'gemini-embedding-2' },
    { text: 'cani', task: 'RETRIEVAL_QUERY' },
  );
  const documentBody = JSON.parse(requests[0]!.body);
  assert.match(requests[0]!.url, /models\/gemini-embedding-2:embedContent$/);
  assert.equal('taskType' in documentBody, false);
  assert.equal('title' in documentBody, false);
  assert.equal(documentBody.output_dimensionality, 4);
  assert.equal(documentBody.model, 'models/gemini-embedding-2');
  assert.equal(
    documentBody.content.parts[0].text,
    'title: dog.png | text: A dog.',
  );
  const queryBody = JSON.parse(requests[1]!.body);
  assert.equal(
    queryBody.content.parts[0].text,
    'task: search result | query: cani',
  );
  for (const request of requests) {
    assert.equal(request.body.includes('secret-key'), false);
    assert.deepEqual(request.headers, {
      'content-type': 'application/json',
      'x-goog-api-key': 'secret-key',
    });
  }
});

test('the schema, config and env defaults expose the search settings', () => {
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    const sql = hostStatements(dialect).join('\n');
    assert.match(sql, /filevora_asset_embeddings/);
    assert.match(sql, /filevora_asset_embeddings_scope/);
  }
  assert.match(
    hostStatements('postgres').join('\n'),
    /embedding BYTEA NOT NULL/,
  );
  const defaults = resolveConfig({}, {});
  assert.equal(defaults.gemini.embeddingModel, 'gemini-embedding-2');
  assert.equal(defaults.gemini.embeddingDimensions, 768);
  assert.equal(defaults.gemini.searchMinScore, 0.65);
  assert.equal(defaults.gemini.searchMaxResults, 100);
  const tuned = resolveConfig(
    {},
    {
      FILEVORA_EMBEDDING_MODEL: 'gemini-embedding-2',
      FILEVORA_EMBEDDING_DIMENSIONS: '1536',
      FILEVORA_SEARCH_MIN_SCORE: '0.62',
      FILEVORA_SEARCH_MAX_RESULTS: '40',
    },
  );
  assert.equal(tuned.gemini.embeddingModel, 'gemini-embedding-2');
  assert.equal(tuned.gemini.embeddingDimensions, 1536);
  assert.equal(tuned.gemini.searchMinScore, 0.62);
  assert.equal(tuned.gemini.searchMaxResults, 40);
  for (const env of [
    { FILEVORA_SEARCH_MIN_SCORE: '1.5' },
    { FILEVORA_SEARCH_MAX_RESULTS: '5000' },
    { FILEVORA_EMBEDDING_DIMENSIONS: '16' },
  ]) {
    assert.throws(() => resolveConfig({}, env));
  }
});

withFiles(
  'upload with describe embeds the description and an Italian query finds it',
  async ({ dir, gemini, files }) => {
    const dog = await uploadText(files, 'dog.txt', 'A dog plays in the park.');
    const cat = await uploadText(files, 'cat.txt', 'A sleepy cat on a sofa.');
    const invoice = await uploadText(
      files,
      'invoice.txt',
      'Invoice 2026-14 with VAT for consulting.',
    );
    const beach = await uploadText(
      files,
      'beach.txt',
      'A beach at sunset with calm sea.',
    );
    assert.equal(dog.description?.status, 'done');

    const rows = embeddingRows(dir);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.model, 'gemini-embedding-2');
      assert.equal(row.dimensions, 768);
      assert.equal(row.bytes, 768 * 4);
      assert.equal(row.content_hash.length, 64);
    }
    const documentCalls = gemini.embedCalls.filter(
      (call) => call.task === 'RETRIEVAL_DOCUMENT',
    );
    assert.equal(documentCalls.length, 4);
    assert.ok(documentCalls.every((call) => call.title?.endsWith('.txt')));
    assert.ok(documentCalls.every((call) => call.dimensions === 768));

    const found = await files.search(
      { query: 'animali che giocano' },
      { principal },
    );
    const ids = found.items.map((item) => item.file.id).sort();
    assert.deepEqual(ids, [cat.id, dog.id].sort());
    assert.equal(found.items.includes(undefined as never), false);
    assert.ok(!ids.includes(invoice.id) && !ids.includes(beach.id));
    assert.equal(found.nextCursor, null);
    assert.deepEqual(found.meta, {
      model: 'gemini-embedding-2',
      dimensions: 768,
      minScore: 0.65,
      maxResults: 100,
      candidatesScored: 4,
      capped: false,
    });
    for (let i = 0; i < found.items.length; i += 1) {
      const item = found.items[i]!;
      assert.ok(item.score >= 0.65 && item.score <= 1);
      assert.equal(Number.isInteger(Math.round(item.score * 1e6)), true);
      assert.ok(item.file.description, 'results carry the description');
      if (i > 0) assert.ok(item.score <= found.items[i - 1]!.score);
    }
    const queryCalls = gemini.embedCalls.filter(
      (call) => call.task === 'RETRIEVAL_QUERY',
    );
    assert.equal(queryCalls.length, 1);
    assert.equal(queryCalls[0]?.title, undefined);

    const lowered = await files.search(
      { query: 'animali che giocano', minScore: 0.4 },
      { principal },
    );
    assert.equal(lowered.items.length, 4, 'a lower minScore admits noise');
    const strict = await files.search(
      { query: 'animali che giocano', minScore: 0.99 },
      { principal },
    );
    assert.deepEqual(strict.items, []);
    assert.equal(strict.nextCursor, null);
  },
);

withFiles(
  'pre-filters narrow the candidates in SQL',
  async ({ dir, files }) => {
    const publicDog = await uploadText(files, 'a.txt', 'A dog in the park.');
    const privateCat = await uploadText(files, 'b.txt', 'A cat on a sofa.');
    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    try {
      db.prepare('UPDATE filevora_assets SET visibility = ? WHERE id = ?').run(
        'public',
        publicDog.id,
      );
      db.prepare('UPDATE filevora_assets SET visibility = ? WHERE id = ?').run(
        'private',
        privateCat.id,
      );
    } finally {
      db.close();
    }
    const run = (input: Record<string, unknown>) =>
      files.search({ query: 'animals', ...input }, { principal });
    const everyone = await run({});
    assert.equal(everyone.items.length, 2);
    const onlyPublic = await run({ visibility: 'public' });
    assert.deepEqual(
      onlyPublic.items.map((item) => item.file.id),
      [publicDog.id],
    );
    const byTag = await run({ tags: 'cat' });
    assert.deepEqual(
      byTag.items.map((item) => item.file.id),
      [privateCat.id],
    );
    const future = await run({ createdFrom: '2999-01-01' });
    assert.deepEqual(future.items, []);
    const wrongType = await run({ type: 'video' });
    assert.deepEqual(wrongType.items, []);
    const other = await files.search(
      { query: 'animals' },
      { principal: { id: 'user-b', tenantId: 'tenant-b' } },
    );
    assert.deepEqual(other.items, [], 'another tenant sees nothing');
  },
);

withFiles(
  'pagination with exact score ties has no duplicates or gaps and embeds the query once',
  async ({ gemini, files }) => {
    const ids: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const file = await uploadText(files, `d${i}.txt`, 'A dog in the park.');
      ids.push(file.id);
    }
    const noise = await uploadText(files, 'x.txt', 'Invoice with VAT.');
    const seen: string[] = [];
    const scores: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await files.search(
        { query: 'dogs', limit: 7, ...(cursor ? { cursor } : {}) },
        { principal },
      );
      pages += 1;
      assert.ok(page.items.length <= 7);
      for (const item of page.items) {
        seen.push(item.file.id);
        scores.push(item.score);
      }
      if (page.nextCursor) assert.equal(page.items.length, 7);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, 15);
    assert.equal(new Set(seen).size, 15, 'no duplicate');
    assert.deepEqual([...seen].sort(), [...ids].sort(), 'no gap');
    assert.ok(!seen.includes(noise.id));
    assert.deepEqual(
      scores,
      [...scores].sort((left, right) => right - left),
    );
    assert.equal(new Set(scores).size, 1, 'identical text gives exact ties');
    assert.deepEqual(
      seen,
      [...seen].sort().reverse(),
      'ties break by asset id descending',
    );
    assert.equal(
      gemini.embedCalls.filter((call) => call.task === 'RETRIEVAL_QUERY')
        .length,
      1,
      'later pages reuse the cached query vector',
    );
  },
);

withFiles(
  'a cursor from a different search is rejected with a talking error',
  async ({ files }) => {
    for (let i = 0; i < 4; i += 1) {
      await uploadText(files, `d${i}.txt`, `A dog number ${i} in the park.`);
    }
    const first = await files.search(
      { query: 'dogs', limit: 2 },
      { principal },
    );
    assert.ok(first.nextCursor);
    for (const changed of [
      { query: 'cats' },
      { query: 'dogs', minScore: 0.6 },
      { query: 'dogs', maxResults: 50 },
      { query: 'dogs', visibility: 'public' as const },
    ]) {
      const error = await searchError(
        files.search(
          { ...changed, limit: 2, cursor: first.nextCursor as string },
          { principal },
        ),
      );
      assert.equal(error.code, 'SEARCH_QUERY_INVALID');
      assert.match(error.message, /cursor does not match/);
    }
    const garbage = await searchError(
      files.search({ query: 'dogs', cursor: 'abc' }, { principal }),
    );
    assert.equal(garbage.code, 'SEARCH_QUERY_INVALID');
    const ok = await files.search(
      { query: 'dogs', limit: 2, cursor: first.nextCursor as string },
      { principal },
    );
    assert.equal(ok.items.length, 2);
  },
);

withFiles(
  'maxResults caps the total across pages and reports capped',
  async ({ files }) => {
    for (let i = 0; i < 9; i += 1) {
      await uploadText(files, `d${i}.txt`, `A dog number ${i} in the park.`);
    }
    const collected: string[] = [];
    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof files.search>> | undefined;
    do {
      last = await files.search(
        {
          query: 'dogs',
          maxResults: 5,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        },
        { principal },
      );
      collected.push(...last.items.map((item) => item.file.id));
      cursor = last.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(collected.length, 5);
    assert.equal(new Set(collected).size, 5);
    assert.equal(last?.items.length, 1);
    assert.equal(last?.nextCursor, null);
    assert.equal(last?.meta.capped, true);
    assert.equal(last?.meta.maxResults, 5);

    const bigPage = await files.search(
      { query: 'dogs', maxResults: 3, limit: 50 },
      { principal },
    );
    assert.equal(bigPage.items.length, 3, 'limit above maxResults is clamped');
    assert.equal(bigPage.nextCursor, null);
    assert.equal(bigPage.meta.capped, true);

    const exact = await files.search(
      { query: 'dogs', maxResults: 9, limit: 50 },
      { principal },
    );
    assert.equal(exact.items.length, 9);
    assert.equal(exact.meta.capped, false, 'nothing was left behind');
  },
);

withFiles(
  'env defaults apply and each request can override them',
  async ({ files }) => {
    for (let i = 0; i < 6; i += 1) {
      await uploadText(files, `d${i}.txt`, `A dog number ${i} in the park.`);
    }
    const defaults = await files.search({ query: 'dogs' }, { principal });
    assert.equal(defaults.items.length, 4, 'FILEVORA_SEARCH_MAX_RESULTS = 4');
    assert.equal(defaults.meta.maxResults, 4);
    assert.equal(defaults.meta.minScore, 0.6);
    assert.equal(defaults.meta.capped, true);
    const widened = await files.search(
      { query: 'dogs', maxResults: 6, minScore: 0.4 },
      { principal },
    );
    assert.equal(widened.items.length, 6);
    assert.equal(widened.meta.maxResults, 6);
    assert.equal(widened.meta.minScore, 0.4);
  },
  { searchMaxResults: 4, searchMinScore: 0.6 },
);

withFiles('search input is validated', async ({ files }) => {
  const bad: Array<Record<string, unknown>> = [
    {},
    { query: '   ' },
    { query: 'x'.repeat(2001) },
    { query: 5 },
    { query: 'dogs', minScore: 1.5 },
    { query: 'dogs', minScore: -0.1 },
    { query: 'dogs', maxResults: 0 },
    { query: 'dogs', maxResults: 1001 },
    { query: 'dogs', maxResults: 1.5 },
    { query: 'dogs', limit: 101 },
    { query: 'dogs', cursor: 7 },
    { query: 'dogs', type: 'poster' },
    { query: 'dogs', createdFrom: 'yesterday-ish' },
  ];
  for (const input of bad) {
    const error = await searchError(
      files.search(input as never, { principal }),
    );
    assert.equal(error.code, 'SEARCH_QUERY_INVALID', JSON.stringify(input));
    assert.equal(error.httpStatus, 400);
  }
  const trimmed = await files.search(
    { query: '  dogs \n  please  ' },
    { principal },
  );
  assert.deepEqual(trimmed.items, []);
});

withFiles(
  'embedding lifecycle: re-describe, delete, failure, and model change',
  async ({ dir, gemini, files }) => {
    const dog = await uploadText(files, 'dog.txt', 'A dog in the park.');
    const rowBefore = embeddingRows(dir).find((row) => row.asset_id === dog.id);
    assert.ok(rowBefore);

    await files.describeAsset(dog.id, { principal });
    const rowAfter = embeddingRows(dir).filter(
      (row) => row.asset_id === dog.id,
    );
    assert.equal(rowAfter.length, 1, 're-describe replaces, never duplicates');
    assert.equal(rowAfter[0]?.content_hash, rowBefore.content_hash);

    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    try {
      db.prepare(
        'UPDATE filevora_asset_embeddings SET dimensions = 512 WHERE asset_id = ?',
      ).run(dog.id);
    } finally {
      db.close();
    }
    const hidden = await files.search({ query: 'dogs' }, { principal });
    assert.deepEqual(hidden.items, [], 'rows of another dimension are ignored');
    await files.describeAsset(dog.id, { principal });
    const restored = await files.search({ query: 'dogs' }, { principal });
    assert.equal(restored.items.length, 1);
    assert.equal(embeddingRows(dir)[0]?.dimensions, 768);

    gemini.embedFailure = { status: 400 };
    const cat = await uploadText(files, 'cat.txt', 'A cat on a sofa.');
    assert.equal(cat.description?.status, 'done', 'description survives');
    assert.equal(cat.processingState === 'failed', false);
    assert.equal(
      embeddingRows(dir).some((row) => row.asset_id === cat.id),
      false,
    );
    gemini.embedFailure = undefined;
    const withoutCat = await files.search({ query: 'animals' }, { principal });
    assert.deepEqual(
      withoutCat.items.map((item) => item.file.id),
      [dog.id],
      'an asset whose embedding failed is left out of search',
    );
    await files.describeAsset(cat.id, { principal });
    const both = await files.search({ query: 'animals' }, { principal });
    assert.equal(both.items.length, 2);

    await files.delete(dog.id, { principal });
    assert.equal(
      embeddingRows(dir).some((row) => row.asset_id === dog.id),
      false,
      'delete removes the embedding',
    );
    const afterDelete = await files.search({ query: 'animals' }, { principal });
    assert.deepEqual(
      afterDelete.items.map((item) => item.file.id),
      [cat.id],
    );
  },
);

withFiles(
  're-describing a ready image updates its embedding',
  async ({ dir, gemini, files }) => {
    const { samplePng } = await import('../dist/testing/index.js');
    const png = samplePng();
    const session = await files.createUploadSession(
      { filename: 'hill.png', mimeType: 'image/png', bytes: png.byteLength },
      { principal },
    );
    await files.writePart(session.id, 1, png, { principal });
    const image = await files.completeUpload(session.id, {}, { principal });
    assert.equal(image.processingState, 'ready');
    assert.equal(embeddingRows(dir).length, 1, 'default describe embeds');
    const calls = gemini.describeCalls.length;
    await files.describeAsset(image.id, { principal });
    assert.ok(gemini.describeCalls.length > calls, 'the describe job re-ran');
    assert.equal(embeddingRows(dir).length, 1);
  },
);

test('a model change leaves old rows unreachable until describe runs again', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-search-model-'));
  const gemini = createMockGemini();
  let files = openSearchFiles(dir, gemini);
  try {
    const dog = await uploadText(files, 'dog.txt', 'A dog in the park.');
    await files.close();
    files = openSearchFiles(dir, gemini, { embeddingDimensions: 256 });
    const none = await files.search({ query: 'dogs' }, { principal });
    assert.deepEqual(none.items, []);
    assert.equal(none.meta.dimensions, 256);
    await files.describeAsset(dog.id, { principal });
    const rows = embeddingRows(dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.dimensions, 256);
    const back = await files.search({ query: 'dogs' }, { principal });
    assert.equal(back.items.length, 1);
    assert.equal(
      gemini.embedCalls.at(-1)?.dimensions,
      256,
      'outputDimensionality follows the config',
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('search talking errors: lite mode, missing key, and embedding outage', async () => {
  const lite = createTestFiles();
  try {
    const error = await searchError(
      lite.files.search({ query: 'dogs' }, { principal: lite.principal }),
    );
    assert.equal(error.code, 'DESCRIPTION_REQUIRES_DATABASE');
    assert.equal(error.httpStatus, 422);
  } finally {
    await lite.close();
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-search-errors-'));
  const keyless = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
  });
  try {
    const error = await searchError(
      keyless.search({ query: 'dogs' }, { principal }),
    );
    assert.equal(error.code, 'DESCRIPTION_NOT_CONFIGURED');
    assert.equal(error.httpStatus, 422);
    assert.match(error.message, /FILEVORA_GEMINI_API_KEY/);
  } finally {
    await keyless.close();
  }

  for (const status of [429, 500]) {
    const gemini = createMockGemini();
    gemini.embedFailure = { status };
    const files = openSearchFiles(path.join(dir, `outage-${status}`), gemini);
    try {
      const error = await searchError(
        files.search({ query: 'dogs' }, { principal }),
      );
      assert.equal(error.code, 'EMBEDDING_UNAVAILABLE');
      assert.equal(error.httpStatus, 503);
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes('test-key'), false, 'key redacted');
    } finally {
      await files.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

withFiles(
  'POST /files/search works over HTTP and through the client',
  async ({ files }) => {
    await uploadText(files, 'dog.txt', 'A dog in the park.');
    await uploadText(files, 'invoice.txt', 'Invoice with VAT.');
    const handler = createFilesHandler({
      files,
      async authenticate() {
        return principal;
      },
      async authorize() {
        return true;
      },
      async policy() {
        return {};
      },
    });
    const response = await handler(
      new Request('http://app.local/files/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'cani', limit: 5 }),
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      items: Array<{ score: number; file: { originalName: string } }>;
      nextCursor: string | null;
      meta: { capped: boolean };
    };
    assert.deepEqual(
      body.items.map((item) => item.file.originalName),
      ['dog.txt'],
    );
    assert.equal(body.nextCursor, null);

    const invalid = await handler(
      new Request('http://app.local/files/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '' }),
      }),
    );
    assert.equal(invalid.status, 400);
    const problem = (await invalid.json()) as { error?: { code?: string } };
    assert.equal(
      JSON.stringify(problem).includes('SEARCH_QUERY_INVALID'),
      true,
    );

    const wrongMethod = await handler(
      new Request('http://app.local/files/search', { method: 'GET' }),
    );
    assert.notEqual(wrongMethod.status, 200);

    const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createUploadClient({
      endpoint: 'http://app.local',
      fetch: async (url, init) => {
        sent.push({ url: String(url), init });
        return handler(new Request(String(url), init));
      },
    });
    const viaClient = await client.search('cani');
    assert.equal(viaClient.items.length, 1);
    assert.equal(sent[0]?.url, 'http://app.local/files/search');
    assert.equal(sent[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(sent[0]?.init?.body)), {
      query: 'cani',
    });
    const withOptions = await client.search({
      query: 'cani',
      minScore: 0.4,
      maxResults: 10,
    });
    assert.equal(withOptions.meta.minScore, 0.4);
    assert.equal(withOptions.meta.maxResults, 10);
  },
);

test('the MCP search_assets tool is listed and runs live', async () => {
  const listed = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const tools = (listed?.result as { tools: Array<{ name: string }> }).tools;
  assert.ok(tools.some((tool) => tool.name === 'search_assets'));

  const call = async (args: Record<string, unknown>) => {
    const reply = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'search_assets', arguments: args },
    });
    return reply?.result as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
  };
  const noTenant = await call({ query: 'dogs' });
  assert.equal(noTenant.isError, true);
  assert.match(noTenant.content[0]?.text ?? '', /tenantId/);
  const lite = await call({
    tenantId: 'tenant-a',
    query: 'dogs',
    env: { FILEVORA_GEMINI_API_KEY: 'k' },
  });
  assert.match(lite.content[0]?.text ?? '', /DESCRIPTION_REQUIRES_DATABASE/);

  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-search-mcp-'));
  const gemini = createMockGemini();
  const files = openSearchFiles(dir, gemini);
  const realFetch = globalThis.fetch;
  try {
    await uploadText(files, 'dog.txt', 'A dog in the park.');
    await uploadText(files, 'invoice.txt', 'Invoice with VAT.');
    const env = {
      FILEVORA_DATABASE_URL: `sqlite://${path.join(dir, 'meta.sqlite')}`,
      FILES_STORAGE_ROOT: path.join(dir, 'objects'),
      FILES_ENV: 'test',
      FILES_PROCESSING_MODE: 'sync',
    };
    const keyless = await call({ tenantId: 'tenant-a', query: 'dogs', env });
    assert.match(keyless.content[0]?.text ?? '', /DESCRIPTION_NOT_CONFIGURED/);
    globalThis.fetch = gemini.fetchImpl;
    const live = await call({
      tenantId: 'tenant-a',
      query: 'cani',
      env: { ...env, FILEVORA_GEMINI_API_KEY: 'test-key' },
    });
    assert.equal(live.isError, undefined, live.content[0]?.text);
    const page = JSON.parse(live.content[0]?.text ?? '{}') as {
      items: Array<{ file: { originalName: string } }>;
    };
    assert.deepEqual(
      page.items.map((item) => item.file.originalName),
      ['dog.txt'],
    );
  } finally {
    globalThis.fetch = realFetch;
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mock embedding vectors have the documented shape', () => {
  const dog = mockEmbeddingValues('A dog in the park.');
  const query = mockEmbeddingValues('cani');
  const invoice = mockEmbeddingValues('Invoice with VAT.');
  assert.equal(dog.length, DIMENSIONS);
  const unit = (values: number[]) => {
    const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
    return Float32Array.from(values.map((v) => v / norm));
  };
  const same = dot(unit(dog), unit(query), DIMENSIONS);
  const other = dot(unit(invoice), unit(query), DIMENSIONS);
  assert.ok(same > 0.6 && same < 0.75, String(same));
  assert.ok(other > 0.4 && other < 0.55, String(other));
});

withFiles('chunked scanning ranks the same as one pass', async ({ files }) => {
  for (let i = 0; i < 9; i += 1) {
    await uploadText(files, `d${i}.txt`, `A dog number ${i} in the park.`);
  }
  await uploadText(files, 'x.txt', 'Invoice with VAT.');
  const sql = await (
    files as unknown as {
      db(): Promise<Parameters<typeof rankEmbeddings>[0]['sql']>;
    }
  ).db();
  const { embedText } = await import('../dist/search/embed.js');
  const bytes = await embedText(
    {
      apiKey: 'test-key',
      embeddingModel: 'gemini-embedding-2',
      embeddingDimensions: 768,
      retryDelayMs: 0,
      fetchImpl: createMockGemini().fetchImpl,
    },
    { text: 'dogs', task: 'RETRIEVAL_QUERY' },
  );
  const base = {
    sql,
    tenantId: principal.tenantId,
    model: 'gemini-embedding-2',
    dimensions: 768,
    queryVector: toFloat32(bytes),
    filters: parseListQuery({}, resolveConfig({}, {})),
    minScoreMicros: 0,
    pageSize: 4,
  };
  const whole = await rankEmbeddings(base);
  const chunked = await rankEmbeddings({ ...base, chunkRows: 2 });
  assert.deepEqual(chunked, whole);
  assert.equal(whole.candidatesScored, 10);
  assert.equal(whole.hits.length, 4);
  assert.equal(whole.hasMore, true);
});

test('retention that removes bytes also removes the embedding', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-search-retain-'));
  const gemini = createMockGemini();
  const files = openSearchFiles(dir, gemini);
  const retained = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    retention: {
      enabled: true,
      unusedAfterDays: 1,
      gracePeriodDays: 0,
      cleanupIntervalMinutes: 1,
    },
    gemini: {
      apiKey: 'test-key',
      fetchImpl: gemini.fetchImpl,
      retryDelayMs: 0,
    },
  });
  try {
    const old = await uploadText(files, 'old.txt', 'A dog in the park.');
    const fresh = await uploadText(files, 'fresh.txt', 'A cat on a sofa.');
    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
    db.prepare(
      'UPDATE filevora_assets SET created_at = ?, last_accessed_at = ? WHERE id = ?',
    ).run(past, past, old.id);
    db.close();
    assert.equal(embeddingRows(dir).length, 2);
    const report = await retained.retentionSweep(
      { dryRun: false },
      { principal },
    );
    assert.equal(report.filesDeleted, 1);
    assert.deepEqual(
      embeddingRows(dir).map((row) => row.asset_id),
      [fresh.id],
    );
  } finally {
    await retained.close();
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function uploadBinary(
  files: ReturnType<typeof createFiles>,
  filename: string,
  mimeType: string,
  body: Uint8Array,
) {
  const session = await files.createUploadSession(
    { filename, mimeType, bytes: body.byteLength, describe: true },
    { principal },
  );
  const chunk = 64 * 1024;
  for (let at = 0, part = 1; at < body.byteLength; at += chunk, part += 1) {
    await files.writePart(session.id, part, body.subarray(at, at + chunk), {
      principal,
    });
  }
  return files.completeUpload(session.id, {}, { principal });
}

async function bigPng(width: number, height: number) {
  const sharp = (await import('sharp')).default;
  return new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 200, g: 120, b: 40 },
      },
    })
      .png()
      .toBuffer(),
  );
}

async function pdfWithPages(pages: number) {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) pdf.addPage();
  return new Uint8Array(await pdf.save());
}

withFiles(
  'an image is embedded as a JPEG rendition together with its description',
  async ({ dir, gemini, files }) => {
    const image = await uploadBinary(
      files,
      'hill.png',
      'image/png',
      await bigPng(3000, 2000),
    );
    assert.equal(image.description?.status, 'done');
    const calls = gemini.embedCalls.filter(
      (call) => call.task !== 'RETRIEVAL_QUERY',
    );
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.file?.mime, 'image/jpeg');
    assert.ok(call.file!.bytes > 0);
    const parts = (
      call.body.content as {
        parts: Array<{
          text?: string;
          inline_data?: { data: string };
        }>;
      }
    ).parts;
    assert.equal(parts.length, 2);
    assert.match(parts[0]!.text ?? '', /calm landscape/);
    assert.equal('taskType' in call.body, false);
    const sharp = (await import('sharp')).default;
    const meta = await sharp(
      Buffer.from(parts[1]!.inline_data!.data, 'base64'),
    ).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(
      Math.max(meta.width ?? 0, meta.height ?? 0),
      EMBED_FILE_LIMITS.imageLongEdge,
    );
    assert.deepEqual(
      embeddingRows(dir).map((row) => [row.source, row.model]),
      [['file+description', 'gemini-embedding-2']],
    );
    const found = await files.search({ query: 'landscape' }, { principal });
    assert.equal(found.meta.model, 'gemini-embedding-2');
  },
);

withFiles(
  'a text file is embedded from its description only',
  async ({ dir, gemini, files }) => {
    await uploadText(files, 'dog.txt', 'A dog plays in the park.');
    const call = gemini.embedCalls.find(
      (entry) => entry.task !== 'RETRIEVAL_QUERY',
    );
    assert.equal(call?.file, undefined);
    assert.equal((call?.body.content as { parts: unknown[] }).parts.length, 1);
    assert.deepEqual(
      embeddingRows(dir).map((row) => row.source),
      ['description'],
    );
  },
);

withFiles(
  'a PDF within the page limit is sent as is, a longer one falls back',
  async ({ dir, gemini, files }) => {
    const short = await uploadBinary(
      files,
      'short.pdf',
      'application/pdf',
      await pdfWithPages(2),
    );
    const long = await uploadBinary(
      files,
      'long.pdf',
      'application/pdf',
      await pdfWithPages(EMBED_FILE_LIMITS.pdfPages + 1),
    );
    const bySource = new Map(
      embeddingRows(dir).map((row) => [row.asset_id, row.source]),
    );
    assert.equal(bySource.get(short.id), 'file+description');
    assert.equal(bySource.get(long.id), 'description');
    const files2 = gemini.embedCalls
      .filter((call) => call.file)
      .map((call) => call.file?.mime);
    assert.deepEqual(files2, ['application/pdf']);
  },
);

withFiles(
  'a file Google rejects is embedded as its description and logged',
  async ({ dir, gemini, files }) => {
    gemini.embedFailureFor = (mime) => (mime ? { status: 400 } : undefined);
    const image = await uploadBinary(
      files,
      'hill.png',
      'image/png',
      await bigPng(64, 64),
    );
    assert.equal(image.description?.status, 'done');
    assert.equal(gemini.embedCalls.length, 2);
    assert.deepEqual(
      embeddingRows(dir).map((row) => row.source),
      ['description'],
    );
  },
);

test('prepareEmbeddingFile renders images and explains every fallback', async () => {
  const sharp = (await import('sharp')).default;
  const base = { ffprobePath: 'ffprobe-does-not-exist', maxPixels: 40_000_000 };
  const webp = new Uint8Array(
    await sharp({
      create: {
        width: 2000,
        height: 500,
        channels: 3,
        background: '#336699',
      },
    })
      .webp()
      .toBuffer(),
  );
  const jpeg = await prepareEmbeddingFile({
    ...base,
    bytes: webp,
    mime: 'image/webp',
  });
  assert.ok('file' in jpeg);
  assert.equal(jpeg.file.mime, 'image/jpeg');
  assert.equal((await sharp(jpeg.file.bytes).metadata()).width, 1024);

  const transparent = new Uint8Array(
    await sharp({
      create: {
        width: 40,
        height: 40,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.4 },
      },
    })
      .png()
      .toBuffer(),
  );
  const png = await prepareEmbeddingFile({
    ...base,
    bytes: transparent,
    mime: 'image/png',
  });
  assert.ok('file' in png);
  assert.equal(png.file.mime, 'image/png');

  const broken = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array([1, 2, 3]),
    mime: 'image/heic',
  });
  assert.ok('reason' in broken);
  assert.match(broken.reason, /^image rendition failed/);

  const text = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(1),
    mime: 'text/plain',
  });
  assert.ok('reason' in text);

  const m4a = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(1),
    mime: 'audio/mp4',
  });
  assert.ok('reason' in m4a);
  assert.match(m4a.reason, /not MP3 or WAV/);

  const longAudio = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(10),
    mime: 'audio/mpeg',
    durationMs: 181_000,
  });
  assert.ok('reason' in longAudio);
  assert.match(longAudio.reason, /limit is 180 s/);

  const longVideo = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(10),
    mime: 'video/mp4',
    durationMs: 121_000,
  });
  assert.ok('reason' in longVideo);

  const okVideo = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(10),
    mime: 'video/mp4',
    durationMs: 60_000,
  });
  assert.ok('file' in okVideo);
  assert.equal(okVideo.file.mime, 'video/mp4');

  const bigAudio = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(EMBED_FILE_LIMITS.maxFileBytes + 1),
    mime: 'audio/wav',
    durationMs: 10_000,
  });
  assert.ok('reason' in bigAudio);

  const unprobeable = await prepareEmbeddingFile({
    ...base,
    bytes: new Uint8Array(10),
    mime: 'audio/wav',
  });
  assert.ok('reason' in unprobeable, 'an original with no ffprobe falls back');
});

function fakeFfmpeg(dir: string, body: string) {
  const script = path.join(dir, 'ffmpeg-fake.sh');
  writeFileSync(
    script,
    `#!/bin/sh\nfor last; do :; done\necho "$@" > "${dir}/args.txt"\n${body}\n`,
  );
  chmodSync(script, 0o755);
  return script;
}

test('convertAudioToMp3 asks ffmpeg for a mono MP3 trimmed to 180 s and cleans up', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-fake-ffmpeg-'));
  try {
    const ffmpegPath = fakeFfmpeg(dir, 'printf "ID3fake" > "$last"');
    const result = await convertAudioToMp3({
      sourcePath: '/tmp/in.m4a',
      ffmpegPath,
    });
    assert.ok('file' in result);
    assert.equal(result.file.mime, 'audio/mpeg');
    assert.equal(Buffer.from(result.file.bytes).toString(), 'ID3fake');
    const args = readFileSync(path.join(dir, 'args.txt'), 'utf8');
    assert.match(args, /-i \/tmp\/in\.m4a/);
    assert.match(args, /-t 180/);
    assert.match(args, /-ac 1/);
    assert.match(args, /-c:a libmp3lame/);
    const output = args.trim().split(' ').at(-1)!;
    assert.equal(existsSync(output), false, 'the temp output is removed');
    assert.equal(existsSync(path.dirname(output)), false);

    const failing = await convertAudioToMp3({
      sourcePath: '/tmp/in.m4a',
      ffmpegPath: fakeFfmpeg(dir, 'exit 1'),
    });
    assert.ok('reason' in failing);
    assert.match(failing.reason, /conversion to MP3 failed/);

    const empty = await convertAudioToMp3({
      sourcePath: '/tmp/in.m4a',
      ffmpegPath: fakeFfmpeg(dir, ': > "$last"'),
    });
    assert.ok('reason' in empty);

    const huge = await convertAudioToMp3({
      sourcePath: '/tmp/in.m4a',
      ffmpegPath: fakeFfmpeg(
        dir,
        `head -c ${EMBED_FILE_LIMITS.maxFileBytes + 1} /dev/zero > "$last"`,
      ),
    });
    assert.ok('reason' in huge);
    assert.match(huge.reason, /converted MP3 is/);

    const missing = await convertAudioToMp3({
      sourcePath: '/tmp/in.m4a',
      ffmpegPath: path.join(dir, 'no-such-ffmpeg'),
    });
    assert.ok('reason' in missing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function toneFile(extension: string, seconds: number): Uint8Array | undefined {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-tone-'));
  const file = path.join(dir, `tone.${extension}`);
  try {
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:sample_rate=8000:duration=${seconds}`,
        '-ac',
        '1',
        file,
      ],
      { stdio: 'ignore' },
    );
    return result.status === 0 ? new Uint8Array(readFileSync(file)) : undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mp3Seconds(base64: string): number {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-probe-'));
  try {
    const file = path.join(dir, 'probe.mp3');
    writeFileSync(file, Buffer.from(base64, 'base64'));
    const out = spawnSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ],
      { encoding: 'utf8' },
    );
    return Number(out.stdout.trim());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

withFiles(
  'audio without an MP3 or WAV rendition is converted to a mono MP3 for embedding',
  async ({ dir, gemini, files }, t) => {
    const ogg = toneFile('ogg', 2);
    if (!ogg) {
      t.skip('ffmpeg is not installed');
      return;
    }
    const audio = await uploadBinary(files, 'tone.ogg', 'audio/ogg', ogg);
    assert.equal(audio.description?.status, 'done');
    const call = gemini.embedCalls.find((entry) => entry.file);
    assert.equal(call?.file?.mime, 'audio/mpeg');
    assert.deepEqual(
      embeddingRows(dir).map((row) => row.source),
      ['file+description'],
    );
  },
);

withFiles(
  'audio longer than 180 s is trimmed to 180 s instead of falling back',
  async ({ gemini, files }, t) => {
    const wav = toneFile('wav', 200);
    if (!wav) {
      t.skip('ffmpeg is not installed');
      return;
    }
    await uploadBinary(files, 'long.wav', 'audio/wav', wav);
    const call = gemini.embedCalls.find((entry) => entry.file);
    assert.equal(call?.file?.mime, 'audio/mpeg');
    const parts = (
      call!.body.content as { parts: Array<{ inline_data?: { data: string } }> }
    ).parts;
    const seconds = mp3Seconds(parts[1]!.inline_data!.data);
    assert.ok(seconds > 170 && seconds <= 181, String(seconds));
  },
);
