import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUploadClient } from '../dist/client/upload-client.js';
import { FileSdkError } from '../dist/errors/error.js';
import { createFilesHandler } from '../dist/http/index.js';
import {
  hostStatements,
  postMigrateStatements,
} from '../dist/metadata/host-schema.js';
import { handleMcpMessage } from '../dist/mcp/stdio.js';
import { createFiles } from '../dist/server/index.js';
import { parseListQuery, storedListSql } from '../dist/server/list-query.js';
import { samplePng } from '../dist/testing/index.js';

const principal = { id: 'user-a', tenantId: 'tenant-a' };
const png = samplePng();

function openStored(dir: string, apiKey = 'test-key') {
  return createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'objects') },
    metadata: { filename: path.join(dir, 'meta.sqlite') },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
    ...(apiKey ? { gemini: { apiKey, describeAssets: false } } : {}),
  });
}

async function upload(files: ReturnType<typeof createFiles>, filename: string) {
  const session = await files.createUploadSession(
    { filename, mimeType: 'image/png', bytes: png.byteLength },
    { principal },
  );
  await files.writePart(session.id, 1, png, { principal });
  return files.completeUpload(session.id, {}, { principal });
}

test('list filters query stored sqlite and reject a bad query', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-list-'));
  const files = openStored(dir);
  try {
    const alpha = await upload(files, 'alpha.png');
    const beta = await upload(files, 'beta.png');
    const gamma = await upload(files, 'gamma.png');
    const db = new DatabaseSync(path.join(dir, 'meta.sqlite'));
    const stamp = '2026-10-15T12:00:00.000Z';
    db.prepare(
      `UPDATE filevora_assets
       SET created_at = ?, bytes = ?, detected_mime = ?, declared_mime = ?, visibility = ?, preset = ?
       WHERE id = ?`,
    ).run(
      stamp,
      100,
      'image/png',
      'image/png',
      'private',
      'web-optimized',
      alpha.id,
    );
    db.prepare(
      `UPDATE filevora_assets
       SET created_at = ?, bytes = ?, detected_mime = ?, declared_mime = ?, visibility = ?, preset = NULL,
           description_long = ?, description_short = ?, description_status = ?
       WHERE id = ?`,
    ).run(
      stamp,
      200,
      'audio/wav',
      'audio/wav',
      'public',
      'Italian speech about the coast. 100%_done',
      'Italian speech',
      'done',
      beta.id,
    );
    db.prepare(
      `UPDATE filevora_assets
       SET created_at = ?, bytes = ?, detected_mime = ?, declared_mime = ?, preset = NULL, description_status = ?,
           description_long = ?, description_short = ?
       WHERE id = ?`,
    ).run(
      stamp,
      300,
      'application/pdf',
      'application/pdf',
      'failed',
      'A joyful hillside office note',
      'Joyful note',
      gamma.id,
    );
    db.prepare(
      `UPDATE filevora_assets
       SET description_long = ?, description_short = ?, description_status = ?
       WHERE id = ?`,
    ).run('A joyful hillside', 'Joyful hill', 'done', alpha.id);
    const insertTag = db.prepare(
      'INSERT INTO filevora_asset_tags (asset_id, category, tag) VALUES (?, ?, ?)',
    );
    insertTag.run(alpha.id, 'emotion', 'joyful');
    insertTag.run(beta.id, 'kind', 'speech');
    insertTag.run(beta.id, 'language', 'italian');
    db.prepare(
      'UPDATE filevora_asset_versions SET width = NULL, height = NULL, duration_ms = NULL',
    ).run();
    db.prepare(
      `INSERT INTO filevora_asset_versions
        (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status, width, height, duration_ms)
       VALUES ('ver_alpha', ?, 'probe', 'preset', 1, 'k', 'image/webp', 10, 'abc', 'ready', 1280, 720, NULL)`,
    ).run(alpha.id);
    db.prepare(
      `INSERT INTO filevora_asset_versions
        (id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, checksum, status, duration_ms)
       VALUES ('ver_beta', ?, 'probe', 'preset', 1, 'k2', 'audio/mp4', 10, 'abc', 'ready', 5000)`,
    ).run(beta.id);
    db.close();

    const images = await files.list({ type: 'image' }, { principal });
    assert.deepEqual(
      images.items.map((item) => item.id),
      [alpha.id],
    );
    const documents = await files.list(
      { types: ['document', 'audio'] },
      { principal },
    );
    assert.deepEqual(
      new Set(documents.items.map((item) => item.id)),
      new Set([beta.id, gamma.id]),
    );
    const joyful = await files.list(
      { tags: 'joyful', tagCategory: 'emotion' },
      { principal },
    );
    assert.deepEqual(
      joyful.items.map((item) => item.id),
      [alpha.id],
    );
    const speech = await files.list(
      { tagsAll: ['kind:speech', 'language:italian'], type: 'audio' },
      { principal },
    );
    assert.deepEqual(
      speech.items.map((item) => item.id),
      [beta.id],
    );
    const words = await files.list({ q: 'italian SPEECH' }, { principal });
    assert.deepEqual(
      words.items.map((item) => item.id),
      [beta.id],
    );
    const literal = await files.list({ q: '100%_done' }, { principal });
    assert.deepEqual(
      literal.items.map((item) => item.id),
      [beta.id],
    );
    const wildcard = await files.list({ q: '%' }, { principal });
    assert.deepEqual(
      wildcard.items.map((item) => item.id),
      [beta.id],
    );
    const described = await files.list({ hasDescription: true }, { principal });
    assert.deepEqual(
      new Set(described.items.map((item) => item.id)),
      new Set([alpha.id, beta.id]),
    );
    const missing = await files.list({ hasDescription: false }, { principal });
    assert.deepEqual(
      missing.items.map((item) => item.id),
      [gamma.id],
    );
    const failed = await files.list(
      { descriptionStatus: 'failed' },
      { principal },
    );
    assert.deepEqual(
      failed.items.map((item) => item.id),
      [gamma.id],
    );
    const sized = await files.list(
      { sizeMin: 150, sizeMax: 250 },
      { principal },
    );
    assert.deepEqual(
      sized.items.map((item) => item.id),
      [beta.id],
    );
    const october = await files.list(
      { createdFrom: '2026-10-01', createdTo: '2026-10-31' },
      { principal },
    );
    assert.equal(october.items.length, 3);
    const november = await files.list(
      { createdFrom: '2026-11-01' },
      { principal },
    );
    assert.equal(november.items.length, 0);
    const named = await files.list({ filename: 'BETA' }, { principal });
    assert.deepEqual(
      named.items.map((item) => item.id),
      [beta.id],
    );
    const prefix = await files.list({ mime: 'audio/' }, { principal });
    assert.deepEqual(
      prefix.items.map((item) => item.id),
      [beta.id],
    );
    const visible = await files.list({ visibility: 'public' }, { principal });
    assert.deepEqual(
      visible.items.map((item) => item.id),
      [beta.id],
    );
    const preset = await files.list({ preset: 'web-optimized' }, { principal });
    assert.deepEqual(
      preset.items.map((item) => item.id),
      [alpha.id],
    );
    const wide = await files.list(
      { widthMin: 1000, heightMin: 700 },
      { principal },
    );
    assert.deepEqual(
      wide.items.map((item) => item.id),
      [alpha.id],
    );
    const long = await files.list(
      { durationMin: 1000, durationMax: 9000 },
      { principal },
    );
    assert.deepEqual(
      long.items.map((item) => item.id),
      [beta.id],
    );
    const bySize = await files.list(
      { sort: 'size', order: 'asc' },
      { principal },
    );
    assert.deepEqual(
      bySize.items.map((item) => item.id),
      [alpha.id, beta.id, gamma.id],
    );
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const next = await files.list(
        { limit: 1, ...(cursor ? { cursor } : {}) },
        { principal },
      );
      assert.equal(next.items.length, 1);
      assert.equal(seen.has(next.items[0]?.id ?? ''), false);
      seen.add(next.items[0]?.id ?? '');
      cursor = next.nextCursor ?? undefined;
      if (!cursor) break;
    }
    assert.equal(seen.size, 3);
    assert.equal(cursor, undefined);

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
      new Request('http://app.local/files?type=image,audio&filename=alpha'),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { items: Array<{ id: string }> };
    assert.deepEqual(
      body.items.map((item) => item.id),
      [alpha.id],
    );

    await assert.rejects(
      files.list({ type: 'poster' }, { principal }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'LIST_QUERY_INVALID');
        assert.match(error.message, /document/);
        return true;
      },
    );
    await assert.rejects(
      files.list(
        { createdFrom: '2026-12-01', createdTo: '2026-01-01' },
        { principal },
      ),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'LIST_QUERY_INVALID');
        assert.match(error.message, /createdFrom/);
        return true;
      },
    );
  } finally {
    await files.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('description filters fail closed without a key or a database', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-list-gate-'));
  const stored = openStored(dir, '');
  const lite = createFiles({
    env: 'test',
    storage: { root: path.join(dir, 'lite') },
    metadata: { mode: 'lite' },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
  });
  try {
    const file = await upload(stored, 'plain.png');
    const found = await stored.list(
      { type: 'image', filename: 'plain' },
      { principal },
    );
    assert.equal(found.items[0]?.id, file.id);
    await assert.rejects(
      stored.list({ q: 'hill' }, { principal }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'DESCRIPTION_NOT_CONFIGURED');
        assert.match(error.message, /FILEVORA_GEMINI_API_KEY/);
        return true;
      },
    );
    const listed = await upload(lite, 'card.png');
    const cards = await lite.list(
      { filename: 'card', type: 'image' },
      { principal },
    );
    assert.equal(cards.items[0]?.id, listed.id);
    const none = await lite.list({ type: 'video' }, { principal });
    assert.equal(none.items.length, 0);
    await assert.rejects(
      lite.list({ tags: 'joyful' }, { principal }),
      (error: unknown) => {
        assert.ok(error instanceof FileSdkError);
        assert.equal(error.code, 'DESCRIPTION_REQUIRES_DATABASE');
        assert.match(error.message, /sqlite:\/\//);
        return true;
      },
    );
  } finally {
    await stored.close();
    await lite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stored list SQL stays a LIKE query on every dialect', () => {
  const parsed = parseListQuery(
    {
      type: 'document',
      q: '100% _joy',
      tagsAll: ['kind:speech', 'language:italian'],
      sort: 'size',
      order: 'asc',
    },
    {
      metadata: { mode: 'stored' },
      gemini: { apiKey: 'test-key' },
    },
  );
  const compiled = storedListSql(parsed, 'tenant-a');
  assert.match(compiled.sql, /ESCAPE '\\'/);
  assert.match(compiled.sql, /filevora_asset_tags/);
  assert.match(compiled.sql, /description_long/);
  assert.match(compiled.sql, /ORDER BY bytes ASC, id ASC/);
  assert.equal(compiled.sql.includes('to_tsvector'), false);
  assert.equal(compiled.sql.includes('embedding'), false);
  assert.ok(compiled.params.includes('%100\\%%'));
  assert.ok(compiled.params.includes('%\\_joy%'));
  for (const dialect of ['sqlite', 'postgres', 'mysql'] as const) {
    const statements = hostStatements(dialect).join('\n');
    assert.match(statements, /filevora_assets_tenant_updated/);
    assert.match(statements, /filevora_asset_tags_category/);
    assert.match(
      postMigrateStatements(dialect).join('\n'),
      /filevora_assets_description_status/,
    );
  }
});

test('the client and MCP tool expose the list query', async () => {
  const urls: string[] = [];
  const client = createUploadClient({
    endpoint: 'http://app.local/api/files',
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
      });
    },
  });
  await client.list({
    type: ['video', 'audio'],
    tagsAll: ['kind:speech', 'language:italian'],
    createdFrom: '2026-10-01',
  });
  assert.match(urls[0] ?? '', /type=video/);
  assert.match(urls[0] ?? '', /type=audio/);
  assert.match(urls[0] ?? '', /tagsAll=kind%3Aspeech/);
  const listed = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'list_files',
      arguments: {
        env: { FILES_ENV: 'test' },
        query: { q: 'joyful' },
      },
    },
  });
  const text = (
    listed?.result as { content: Array<{ text: string }>; isError?: boolean }
  ).content[0]?.text;
  assert.equal((listed?.result as { isError?: boolean }).isError, true);
  assert.match(text ?? '', /DESCRIPTION_REQUIRES_DATABASE/);
});
