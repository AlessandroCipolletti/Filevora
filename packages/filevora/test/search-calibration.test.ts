import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_GEMINI_MODEL } from '../dist/descriptions/gemini.js';
import { describeBytes } from '../dist/descriptions/run.js';
import { DEFAULT_SEMANTIC_SEARCH_MIN_SCORE } from '../dist/search/defaults.js';
import {
  buildCanonicalEmbeddingText,
  embedDocument,
  embedText,
  toFloat32,
} from '../dist/search/embed.js';
import {
  convertAudioToMp3,
  prepareEmbeddingFile,
} from '../dist/search/embed-file.js';
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
    /** Why the file could not be sent, when it was not. */
    fallbackReason?: string;
  }>;
  queries: Array<{ text: string; relevant: string[] }>;
}

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/search-calibration.json', import.meta.url),
    'utf8',
  ),
) as Fixture;

const SWEEP = Array.from({ length: 31 }, (_, index) => (50 + index) / 100);
const liveKey = process.env.FILEVORA_CALIBRATION_GEMINI_KEY;

async function report(
  config: Parameters<typeof embedText>[0],
  subject: Fixture = fixture,
  thresholds: number[] = SWEEP,
) {
  const documents = new Map<string, Float32Array>();
  const sources: string[] = [];
  const fallbacks: Array<{ id: string; reason: string }> = [];
  for (const asset of subject.assets) {
    const canonical = buildCanonicalEmbeddingText({
      assetType: asset.assetType,
      mime: asset.mime,
      originalName: asset.name,
      descriptionShort: asset.short,
      descriptionLong: asset.long,
      tags: asset.tags.map(([category, tag]) => ({ category, tag })),
    });
    if (asset.fallbackReason) {
      fallbacks.push({ id: asset.id, reason: asset.fallbackReason });
    }
    const embedded = await embedDocument(
      config,
      {
        text: canonical.text,
        title: canonical.title,
        ...(asset.file ? { file: asset.file } : {}),
      },
      (message) => {
        fallbacks.push({ id: asset.id, reason: message });
        console.log(`  ${asset.id}: ${message}`);
      },
    );
    sources.push(embedded.source);
    documents.set(asset.id, toFloat32(embedded.vector));
  }
  const scores: Array<{
    text: string;
    relevant: string[];
    scored: Array<[string, number]>;
  }> = [];
  for (const query of subject.queries) {
    const vector = toFloat32(
      await embedText(config, { text: query.text, task: 'RETRIEVAL_QUERY' }),
    );
    scores.push({
      text: query.text,
      relevant: query.relevant,
      scored: [...documents]
        .map(([id, doc]): [string, number] => [
          id,
          dot(vector, doc, config.embeddingDimensions),
        ])
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
    });
  }
  const rows = thresholds.map((threshold) => {
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
    const precision = returned === 0 ? 1 : truePositive / returned;
    const recall = relevant === 0 ? 1 : truePositive / relevant;
    return {
      threshold,
      precision,
      recall,
      f1:
        precision + recall === 0
          ? 0
          : (2 * precision * recall) / (precision + recall),
    };
  });
  return Object.assign(rows, { sources, scores, fallbacks });
}

/** Top 5 per query with a relevance mark, and the labeled files that did not reach the top 10. */
function perQuery(rows: Awaited<ReturnType<typeof report>>) {
  const lines: string[] = ['Per query (+ relevant, - not relevant):'];
  for (const entry of rows.scores) {
    lines.push(
      `Q "${entry.text}"  relevant: ${entry.relevant.length > 0 ? entry.relevant.join(', ') : 'none'}`,
    );
    entry.scored.slice(0, 5).forEach(([id, score], index) => {
      lines.push(
        `  ${index + 1}. ${entry.relevant.includes(id) ? '+' : '-'} ${id}  ${score.toFixed(2)}`,
      );
    });
    const missed = entry.relevant
      .map((id) => ({
        id,
        rank: entry.scored.findIndex(([other]) => other === id) + 1,
        score: entry.scored.find(([other]) => other === id)?.[1] ?? 0,
      }))
      .filter((item) => item.rank === 0 || item.rank > 10);
    if (entry.relevant.length > 0) {
      lines.push(
        `  missed in top 10: ${missed.length === 0 ? 'none' : missed.map((item) => `${item.id} (rank ${item.rank || 'n/a'}, ${item.score.toFixed(2)})`).join(', ')}`,
      );
    }
  }
  return lines.join('\n');
}

function fallbackList(rows: Awaited<ReturnType<typeof report>>) {
  if (rows.fallbacks.length === 0) return 'Files not sent: none.';
  return [
    `Files not sent with their description (${rows.fallbacks.length}):`,
    ...rows.fallbacks.map((item) => `  ${item.id}: ${item.reason}`),
  ].join('\n');
}

function bestF1(rows: Awaited<ReturnType<typeof report>>) {
  return rows.reduce((best, row) => (row.f1 > best.f1 ? row : best));
}

function table(rows: Awaited<ReturnType<typeof report>>) {
  const withFile = rows.sources.filter(
    (source) => source === 'file+description',
  ).length;
  const best = bestF1(rows);
  return [
    `Embedded as file+description: ${withFile} of ${rows.sources.length}; description only: ${rows.sources.length - withFile}.`,
    fallbackList(rows),
    perQuery(rows),
    'minScore  precision  recall  F1',
    ...rows.map(
      (row) =>
        `${row.threshold.toFixed(2)}      ${row.precision.toFixed(2)}       ${row.recall.toFixed(2)}    ${row.f1.toFixed(2)}${row === best ? '  <- best F1' : ''}`,
    ),
    `Best F1 ${best.f1.toFixed(2)} at minScore ${best.threshold.toFixed(2)} (precision ${best.precision.toFixed(2)}, recall ${best.recall.toFixed(2)}).`,
  ].join('\n');
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

test('calibration harness on the MOCK embedding model (does not validate the default)', async () => {
  const mock = {
    apiKey: 'test-key',
    embeddingModel: 'gemini-embedding-2',
    embeddingDimensions: 768,
    retryDelayMs: 0,
    fetchImpl: createMockGemini().fetchImpl,
  };
  const everything = await report(mock);
  console.log(
    `Calibration fixture: ${fixture.label}\nEmbeddings: MOCK (offline), full fixture of ${fixture.assets.length} assets and ${fixture.queries.length} queries; the mock only models some concepts.\nBest F1 ${bestF1(everything).f1.toFixed(2)} at minScore ${bestF1(everything).threshold.toFixed(2)}.`,
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
  assert.equal(DEFAULT_SEMANTIC_SEARCH_MIN_SCORE, 0.65);
  const atDefault = rows.find((row) => row.threshold === 0.65);
  assert.ok(atDefault && atDefault.precision === 1 && atDefault.recall === 1);
  assert.equal(atDefault.f1, 1);
  assert.equal(rows.length, 31);
  assert.equal(rows[0]?.threshold, 0.5);
  assert.equal(rows.at(-1)?.threshold, 0.8);
  assert.equal(bestF1(rows).f1, 1);
  const output = table(rows);
  assert.match(output, /Q "[^"]+" {2}relevant: /);
  assert.match(output, /\n {2}1\. [+-] \S+ {2}\d\.\d\d/);
  assert.match(output, /missed in top 10: none/);
  assert.match(output, /Files not sent: none\./);
  assert.match(output, /<- best F1/);
  const [atFloor] = await report(mock, MOCK_MODELLED, [0.45]);
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
  /** Free text for the person editing the file. Ignored. */
  _help?: string[];
  /** Optional. Every known file in the folder is an asset; an entry only overrides one. */
  assets?: Array<{
    file: string;
    name?: string;
    short?: string;
    long?: string;
    tags?: Array<[string, string]>;
  }>;
  queries: Array<{ text: string; relevant: string[] }>;
}

interface CachedDescription {
  sha256: string;
  model: string;
  short: string;
  long: string;
  tags: Array<[string, string]>;
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
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

const CACHE_FILE = 'descriptions.cache.json';

function assetTypeOf(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Reads real files and queries from a folder. Missing descriptions come from the real describe
 * code path and are cached next to the files, so a re-run does not call Gemini again.
 */
async function loadFilesFixture(
  dir: string,
  options: { apiKey: string; model: string; fetchImpl?: typeof fetch },
): Promise<Fixture & { describeCalls: number }> {
  const labels = JSON.parse(
    readFileSync(path.join(dir, 'labels.json'), 'utf8'),
  ) as FilesLabels;
  const overrides = new Map(
    (labels.assets ?? []).map((entry) => [entry.file, entry]),
  );
  const names = [
    ...new Set([
      ...readdirSync(dir).filter(
        (name) =>
          !name.startsWith('.') &&
          path.extname(name).toLowerCase() in MIME_BY_EXTENSION,
      ),
      ...overrides.keys(),
    ]),
  ].sort();
  const cachePath = path.join(dir, CACHE_FILE);
  const cache: Record<string, CachedDescription> = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, 'utf8')) as typeof cache)
    : {};
  let describeCalls = 0;
  const assets: Fixture['assets'] = [];
  for (const file of names) {
    const raw = new Uint8Array(readFileSync(path.join(dir, file)));
    const mime =
      MIME_BY_EXTENSION[path.extname(file).toLowerCase()] ??
      'application/octet-stream';
    const override = overrides.get(file);
    const ffprobePath = process.env.FILES_FFPROBE_PATH ?? 'ffprobe';
    let prepared = await prepareEmbeddingFile({
      bytes: raw,
      mime,
      ffprobePath,
      maxPixels: 40_000_000,
    });
    if ('reason' in prepared && mime.startsWith('audio/')) {
      const converted = await convertAudioToMp3({
        sourcePath: path.join(dir, file),
        ffmpegPath: process.env.FILES_FFMPEG_PATH ?? 'ffmpeg',
      });
      prepared =
        'file' in converted
          ? converted
          : { reason: `${prepared.reason}; ${converted.reason}` };
    }
    console.log(
      'file' in prepared
        ? `  ${file}: rendition ${prepared.rendition} (${prepared.file.bytes.byteLength} bytes)`
        : `  ${file}: description only (${prepared.reason})`,
    );
    let short = override?.short;
    let long = override?.long;
    let tags = override?.tags;
    if (short === undefined || long === undefined || tags === undefined) {
      const hash = createHash('sha256').update(raw).digest('hex');
      let cached = cache[file];
      if (!cached || cached.sha256 !== hash || cached.model !== options.model) {
        describeCalls += 1;
        const described = await describeBytes({
          apiKey: options.apiKey,
          model: options.model,
          mime,
          ...('file' in prepared && prepared.file.mime !== mime
            ? { sourceMime: prepared.file.mime }
            : {}),
          bytes: 'file' in prepared ? prepared.file.bytes : raw,
          retryDelayMs: 500,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        cached = {
          sha256: hash,
          model: options.model,
          short: described.short,
          long: described.long,
          tags: described.tags.map((entry) => [entry.category, entry.tag]),
        };
        cache[file] = cached;
        writeFileSync(cachePath, JSON.stringify(cache, null, 2));
        console.log(`  ${file}: described with ${options.model} and cached`);
      }
      short ??= cached.short;
      long ??= cached.long;
      tags ??= cached.tags;
    }
    assets.push({
      id: file,
      assetType: assetTypeOf(mime),
      mime,
      name: override?.name ?? file,
      short,
      long,
      tags,
      ...('file' in prepared
        ? { file: prepared.file }
        : { fallbackReason: prepared.reason }),
    });
  }
  return {
    label: `real files from FILEVORA_CALIBRATION_FILES_DIR (${assets.length} assets)`,
    assets,
    queries: labels.queries,
    describeCalls,
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
  assert.ok(example.queries.length > 0);
  for (const query of example.queries) {
    assert.equal(typeof query.text, 'string');
    assert.ok(Array.isArray(query.relevant));
  }
  for (const entry of example.assets ?? []) {
    assert.equal(typeof entry.file, 'string');
  }
});

test('missing descriptions are generated once and cached next to the files', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-calibration-files-'));
  try {
    writeFileSync(path.join(dir, 'dog.txt'), 'A dog plays in the park.');
    writeFileSync(path.join(dir, 'cat.txt'), 'A sleepy cat on a sofa.');
    writeFileSync(path.join(dir, 'notes.bin'), 'ignored');
    writeFileSync(
      path.join(dir, 'labels.json'),
      JSON.stringify({
        assets: [
          {
            file: 'cat.txt',
            short: 'Own short.',
            long: 'Own long.',
            tags: [['subject', 'cat']],
          },
        ],
        queries: [{ text: 'animali', relevant: ['dog.txt', 'cat.txt'] }],
      }),
    );
    const gemini = createMockGemini();
    const options = {
      apiKey: 'test-key',
      model: 'gemini-test',
      fetchImpl: gemini.fetchImpl,
    };
    const first = await loadFilesFixture(dir, options);
    assert.deepEqual(
      first.assets.map((asset) => asset.id),
      ['cat.txt', 'dog.txt'],
    );
    assert.equal(first.describeCalls, 1, 'cat.txt has its own description');
    assert.equal(gemini.describeCalls.length, 1);
    const cat = first.assets.find((asset) => asset.id === 'cat.txt');
    assert.equal(cat?.short, 'Own short.');
    const dog = first.assets.find((asset) => asset.id === 'dog.txt');
    assert.match(dog?.long ?? '', /dog plays/);
    assert.ok(dog?.tags.length);
    assert.equal(existsSync(path.join(dir, 'descriptions.cache.json')), true);

    const second = await loadFilesFixture(dir, options);
    assert.equal(second.describeCalls, 0, 'the cache avoids a second call');
    assert.equal(gemini.describeCalls.length, 1);
    assert.deepEqual(
      second.assets.map((asset) => asset.long),
      first.assets.map((asset) => asset.long),
    );

    writeFileSync(path.join(dir, 'dog.txt'), 'A dog sleeps.');
    const withFallback = await report(
      {
        apiKey: 'k',
        embeddingModel: 'gemini-embedding-2',
        embeddingDimensions: 768,
        retryDelayMs: 0,
        fetchImpl: gemini.fetchImpl,
      },
      {
        ...second,
        assets: second.assets.map((asset) => ({
          ...asset,
          fallbackReason: 'forced fallback',
        })),
      },
      [0.5],
    );
    assert.match(
      table(withFallback),
      /Files not sent with their description \(2\)/,
    );
    assert.match(table(withFallback), /dog\.txt: forced fallback/);

    const third = await loadFilesFixture(dir, options);
    assert.equal(third.describeCalls, 1, 'a changed file is described again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    const subject = await loadFilesFixture(filesDir as string, {
      apiKey: liveKey as string,
      model: process.env.FILEVORA_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
    });
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
