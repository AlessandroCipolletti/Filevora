import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_SEARCH_MIN_SCORE } from '../dist/search/defaults.js';
import {
  buildCanonicalEmbeddingText,
  embedText,
  toFloat32,
} from '../dist/search/embed.js';
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

async function report(config: Parameters<typeof embedText>[0]) {
  const documents = new Map<string, Float32Array>();
  for (const asset of fixture.assets) {
    const canonical = buildCanonicalEmbeddingText({
      assetType: asset.assetType,
      mime: asset.mime,
      originalName: asset.name,
      descriptionShort: asset.short,
      descriptionLong: asset.long,
      tags: asset.tags.map(([category, tag]) => ({ category, tag })),
    });
    documents.set(
      asset.id,
      toFloat32(
        await embedText(config, {
          text: canonical.text,
          title: canonical.title,
          task: 'RETRIEVAL_DOCUMENT',
        }),
      ),
    );
  }
  const scores: Array<{ relevant: string[]; scored: Array<[string, number]> }> =
    [];
  for (const query of fixture.queries) {
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
  return THRESHOLDS.map((threshold) => {
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
}

function table(rows: Awaited<ReturnType<typeof report>>) {
  return rows
    .map(
      (row) =>
        `minScore ${row.threshold.toFixed(2)}  precision ${row.precision.toFixed(2)}  recall ${row.recall.toFixed(2)}`,
    )
    .join('\n');
}

test('calibration harness on the MOCK embedding model (does not validate the 0.55 default)', async () => {
  const rows = await report({
    apiKey: 'test-key',
    embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768,
    retryDelayMs: 0,
    fetchImpl: createMockGemini().fetchImpl,
  });
  console.log(
    `Calibration fixture: ${fixture.label}\nEmbeddings: MOCK (offline).\n${table(rows)}`,
  );
  assert.equal(DEFAULT_SEARCH_MIN_SCORE, 0.55);
  const atDefault = rows.find((row) => row.threshold === 0.55);
  assert.ok(atDefault && atDefault.precision === 1 && atDefault.recall === 1);
  const atFloor = rows.find((row) => row.threshold === 0.45);
  assert.ok(atFloor && atFloor.precision < 1, 'a low threshold lets noise in');
  const sorted = [...rows].sort((a, b) => a.threshold - b.threshold);
  for (let i = 1; i < sorted.length; i += 1) {
    assert.ok(sorted[i]!.recall <= sorted[i - 1]!.recall);
  }
});

test(
  'calibration against the real Gemini embedding model',
  { skip: liveKey ? false : 'Set FILEVORA_CALIBRATION_GEMINI_KEY to run.' },
  async () => {
    const rows = await report({
      apiKey: liveKey as string,
      embeddingModel: 'gemini-embedding-001',
      embeddingDimensions: 768,
      retryDelayMs: 500,
    });
    console.log(
      `Calibration fixture: ${fixture.label}\nEmbeddings: LIVE gemini-embedding-001 @ 768.\n${table(rows)}`,
    );
  },
);
