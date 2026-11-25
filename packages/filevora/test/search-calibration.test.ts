import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_SEARCH_MIN_SCORE } from '../dist/search/defaults.js';
import {
  buildCanonicalEmbeddingText,
  embedDocument,
  embedText,
  toFloat32,
} from '../dist/search/embed.js';
import { prepareEmbeddingFile } from '../dist/search/embed-file.js';
import { dot } from '../dist/search/rank.js';
import { createMockGemini } from './search-helpers.ts';

interface Fixture {
  label: string;
  assets: Array<{
    id: string;
    assetType: string;
    mime: string;
    name: string;
    short: string;
    long: string;
    tags: Array<[string, string]>;
    file?: { bytes: Uint8Array; mime: string };
  }>;
  queries: Array<{ text: string; relevant: string[] }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/search-calibration.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const THRESHOLDS = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
const liveKey = process.env.FILEVORA_CALIBRATION_GEMINI_KEY;

async function report(
  config: Parameters<typeof embedText>[0],
  subject: Fixture = fixture,
) {
  const documents = new Map<string, Float32Array>();
  const sources: string[] = [];
  for (const asset of subject.assets) {
    const canonical = buildCanonicalEmbeddingText({
      assetType: asset.assetType,
      mime: asset.mime,
      originalName: asset.name,
      descriptionShort: asset.short,
      descriptionLong: asset.long,
      tags: asset.tags.map(([category, tag]) => ({ category, tag })),
    });
    const embedded = await embedDocument(
      config,
      {
        text: canonical.text,
        title: canonical.title,
        ...(asset.file ? { file: asset.file } : {}),
      },
      (message) => console.log(`  ${asset.id}: ${message}`),
    );
    sources.push(embedded.source);
    documents.set(asset.id, toFloat32(embedded.vector));
  }
  const scores: Array<{ relevant: string[]; scored: Array<[string, number]> }> =
    [];
  for (const query of subject.queries) {
    const vector = toFloat32(
      await embedText(config, { text: query.text, task: 'RETRIEVAL_QUERY' }),
    );
    scores.push({
      relevant: query.relevant,
      scored: [...documents].map(([id, doc]) => [
        id,
        dot(vector, doc, config.embeddingDimensions),
      ]),
    });
  }
  const rows = THRESHOLDS.map((threshold) => {
    let truePositive = 0;
    let returned = 0;
    let relevant = 0;
    for (const entry of scores) {
      relevant += entry.relevant.length;
      for (const [id, score] of entry.scored) {
        if (score < threshold) continue;
        returned += 1;
        if (entry.relevant.includes(id)) truePositive += 1;
      }
    }
    return {
      threshold,
      precision: returned === 0 ? 1 : truePositive / returned,
      recall: relevant === 0 ? 1 : truePositive / relevant,
    };
  });
  return Object.assign(rows, { sources });
}

function table(rows: Awaited<ReturnType<typeof report>>) {
  const withFile = rows.sources.filter(
    (source) => source === 'file+description',
  ).length;
  const sources = `Embedded as file+description: ${withFile} of ${rows.sources.length}; description only: ${rows.sources.length - withFile}.\n`;
  return (
    sources +
    rows
      .map(
        (row) =>
          `minScore ${row.threshold.toFixed(2)}  precision ${row.precision.toFixed(2)}  recall ${row.recall.toFixed(2)}`,
      )
      .join('\n')
  );
}

// The mock only models three concept clusters (animals, invoices, beach or sunset).
// The first eight assets and first six queries were written around those clusters,
// so only that subset can be scored exactly. The rest of the fixture is for the live run.
const MOCK_MODELLED: Fixture = {
  label: fixture.label,
  assets: fixture.assets.slice(0, 8),
  queries: fixture.queries.slice(0, 6).map((query) => ({
    ...query,
    relevant: query.relevant.filter((id) =>
      fixture.assets.slice(0, 8).some((asset) => asset.id === id),
    ),
  })),
};

test('calibration fixture is well formed', () => {
  const ids = fixture.assets.map((asset) => asset.id);
  assert.equal(new Set(ids).size, ids.length, 'asset ids are unique');
  assert.ok(
    fixture.assets.length >= 30,
    'enough assets for a threshold picture',
  );
  assert.ok(fixture.queries.length >= 20, 'enough labeled queries');
  assert.ok(
    fixture.queries.some((query) => query.relevant.length === 0),
    'at least one query has no relevant asset',
  );
  for (const query of fixture.queries) {
    for (const id of query.relevant) {
      assert.ok(
        ids.includes(id),
        `query "${query.text}" names unknown asset ${id}`,
      );
    }
  }
});

test('calibration harness on the MOCK embedding model (does not validate the 0.55 default)', async () => {
  const mock = {
    apiKey: 'test-key',
    embeddingModel: 'gemini-embedding-2',
    embeddingDimensions: 768,
    retryDelayMs: 0,
    fetchImpl: createMockGemini().fetchImpl,
  };
  const everything = await report(mock);
  console.log(
    `Calibration fixture: ${fixture.label}\nEmbeddings: MOCK (offline), full fixture of ${fixture.assets.length} assets and ${fixture.queries.length} queries; the mock only models some concepts.\n${table(everything)}`,
  );
  for (const row of everything) {
    assert.ok(row.precision >= 0 && row.precision <= 1);
    assert.ok(row.recall >= 0 && row.recall <= 1);
  }
  const loose = [...everything].sort((a, b) => a.threshold - b.threshold);
  for (let i = 1; i < loose.length; i += 1) {
    assert.ok(loose[i]!.recall <= loose[i - 1]!.recall);
  }

  const rows = await report(mock, MOCK_MODELLED);
  assert.equal(DEFAULT_SEARCH_MIN_SCORE, 0.55);
  const atDefault = rows.find((row) => row.threshold === 0.55);
  assert.ok(atDefault && atDefault.precision === 1 && atDefault.recall === 1);
  const atFloor = rows.find((row) => row.threshold === 0.45);
  assert.ok(atFloor && atFloor.precision < 1, 'a low threshold lets noise in');
});

test(
  'calibration against the real Gemini embedding model',
  { skip: liveKey ? false : 'Set FILEVORA_CALIBRATION_GEMINI_KEY to run.' },
  async () => {
    const rows = await report({
      apiKey: liveKey as string,
      embeddingModel: 'gemini-embedding-2',
      embeddingDimensions: 768,
      retryDelayMs: 500,
    });
    console.log(
      `Calibration fixture: ${fixture.label}\nEmbeddings: LIVE gemini-embedding-2 @ 768 (descriptions only).\n${table(rows)}`,
    );
  },
);

interface FilesLabels {
  assets: Array<{
    file: string;
    short: string;
    long: string;
    name?: string;
    tags?: Array<[string, string]>;
  }>;
  queries: Array<{ text: string; relevant: string[] }>;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

function assetTypeOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Reads real files and a labels.json from a folder, rendering each file like production does. */
async function loadFilesFixture(dir: string): Promise<Fixture> {
  const labels = JSON.parse(
    readFileSync(path.join(dir, 'labels.json'), 'utf8'),
  ) as FilesLabels;
  const assets: Fixture['assets'] = [];
  for (const entry of labels.assets) {
    const mime =
      MIME_BY_EXTENSION[path.extname(entry.file).toLowerCase()] ??
      'application/octet-stream';
    const prepared = await prepareEmbeddingFile({
      bytes: new Uint8Array(readFileSync(path.join(dir, entry.file))),
      mime,
      ffprobePath: process.env.FILES_FFPROBE_PATH ?? 'ffprobe',
      maxPixels: 40_000_000,
    });
    console.log(
      'file' in prepared
        ? `  ${entry.file}: rendition ${prepared.rendition} (${prepared.file.bytes.byteLength} bytes)`
        : `  ${entry.file}: description only (${prepared.reason})`,
    );
    assets.push({
      id: entry.file,
      assetType: assetTypeOf(mime),
      mime,
      name: entry.name ?? entry.file,
      short: entry.short,
      long: entry.long,
      tags: entry.tags ?? [],
      ...('file' in prepared ? { file: prepared.file } : {}),
    });
  }
  return {
    label: `real files from FILEVORA_CALIBRATION_FILES_DIR (${assets.length} assets)`,
    assets,
    queries: labels.queries,
  };
}

test('the example labels file matches the loader format', () => {
  const example = JSON.parse(
    readFileSync(
      new URL(
        './fixtures/calibration-files.labels.example.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as FilesLabels;
  const files = example.assets.map((asset) => asset.file);
  assert.equal(new Set(files).size, files.length);
  for (const query of example.queries) {
    for (const file of query.relevant) assert.ok(files.includes(file));
  }
});

const filesDir = process.env.FILEVORA_CALIBRATION_FILES_DIR;

test(
  'calibration with real files and descriptions',
  {
    skip:
      liveKey && filesDir && existsSync(path.join(filesDir, 'labels.json'))
        ? false
        : 'Set FILEVORA_CALIBRATION_GEMINI_KEY and FILEVORA_CALIBRATION_FILES_DIR (a folder with labels.json).',
  },
  async () => {
    const subject = await loadFilesFixture(filesDir as string);
    const rows = await report(
      {
        apiKey: liveKey as string,
        embeddingModel: 'gemini-embedding-2',
        embeddingDimensions: 768,
        retryDelayMs: 500,
      },
      subject,
    );
    console.log(
      `Calibration: ${subject.label}\nEmbeddings: LIVE gemini-embedding-2 @ 768, files plus descriptions.\n${table(rows)}`,
    );
  },
);
