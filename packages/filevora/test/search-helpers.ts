import { createHash } from 'node:crypto';
import { createFiles } from '../dist/server/index.js';
import type { FilesOptions } from '../dist/config/schema.js';

/**
 * Offline stand-in for Gemini used by the search tests. It is a mock, not a model:
 * the vectors are built so concept clusters score about 0.68 against each other
 * and unrelated texts about 0.48, which is the shape seen in the plan's estimates.
 */
export const DIMENSIONS = 768;
const COMMON_WEIGHT = Math.sqrt(0.48);
const CLUSTER_WEIGHT = Math.sqrt(0.2);
const NOISE_WEIGHT = Math.sqrt(0.32);
const RAW_SCALE = 3.7;

const CLUSTERS: Array<{ axis: number; pattern: RegExp }> = [
  {
    axis: 0,
    pattern:
      /\b(dogs?|cats?|puppy|puppies|kittens?|animals?|pets?|cane|cani|gatto|gatti|animali)\b/i,
  },
  {
    axis: 1,
    pattern:
      /\b(invoice|invoices|fattura|fatture|vat|iva|payment|pagamento)\b/i,
  },
  {
    axis: 2,
    pattern: /\b(beach|sunset|sea|spiaggia|tramonto|mare)\b/i,
  },
];

function noiseVector(text: string, from: number): number[] {
  const values: number[] = [];
  let sumSq = 0;
  for (let block = 0; values.length < DIMENSIONS - from; block += 1) {
    const digest = createHash('sha256').update(`${block}:${text}`).digest();
    for (const byte of digest) {
      if (values.length >= DIMENSIONS - from) break;
      const value = byte / 255 - 0.5;
      values.push(value);
      sumSq += value * value;
    }
  }
  const inv = 1 / Math.sqrt(sumSq);
  return values.map((value) => value * inv);
}

export function mockEmbeddingValues(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[3] = COMMON_WEIGHT;
  let clustered = false;
  for (const cluster of CLUSTERS) {
    if (cluster.pattern.test(text)) {
      vector[cluster.axis] = CLUSTER_WEIGHT;
      clustered = true;
    }
  }
  // Keep every vector at unit norm so unrelated texts all sit near the same baseline.
  const noiseWeight = clustered ? NOISE_WEIGHT : Math.sqrt(0.52);
  noiseVector(text, 4).forEach((value, index) => {
    vector[4 + index] = value * noiseWeight;
  });
  return vector.map((value) => value * RAW_SCALE);
}

export interface EmbedCall {
  task: string | undefined;
  title: string | undefined;
  text: string;
  dimensions: number | undefined;
}

export interface MockGemini {
  fetchImpl: typeof fetch;
  embedCalls: EmbedCall[];
  describeCalls: string[];
  /** When set, embedContent fails with this status. */
  embedFailure: { status: number } | undefined;
}

/** Describe responses echo the uploaded text file, so file content is the description. */
export function createMockGemini(): MockGemini {
  const state: MockGemini = {
    embedCalls: [],
    describeCalls: [],
    embedFailure: undefined,
    fetchImpl: async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      if (url.includes(':embedContent')) {
        const content = body.content as { parts: Array<{ text: string }> };
        const text = content.parts[0]?.text ?? '';
        state.embedCalls.push({
          task: body.taskType as string | undefined,
          title: body.title as string | undefined,
          text,
          dimensions: body.outputDimensionality as number | undefined,
        });
        if (state.embedFailure) {
          return new Response('quota exhausted test-key', {
            status: state.embedFailure.status,
          });
        }
        const wanted = (body.outputDimensionality as number) ?? DIMENSIONS;
        return new Response(
          JSON.stringify({
            embedding: { values: mockEmbeddingValues(text).slice(0, wanted) },
          }),
          { status: 200 },
        );
      }
      if (url.includes(':generateContent')) {
        const parts = (
          body.contents as Array<{
            parts: Array<{ inlineData?: { data?: string; mimeType?: string } }>;
          }>
        )[0]?.parts;
        const inline = parts?.find((part) => part.inlineData?.data)?.inlineData;
        const mime = inline?.mimeType ?? '';
        state.describeCalls.push(mime);
        const text = inline?.mimeType?.startsWith('text/')
          ? Buffer.from(inline.data ?? '', 'base64').toString('utf8')
          : 'A calm landscape with a hill.';
        const words = [
          ...new Set(text.toLowerCase().match(/[a-z]{3,}/g) ?? ['asset']),
        ].slice(0, 5);
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        description_long: text,
                        description_short: text.slice(0, 60),
                        tags: words.map((tag) => ({
                          category: 'subject',
                          tag,
                        })),
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    },
  };
  return state;
}

export function openSearchFiles(
  dir: string,
  gemini: MockGemini,
  overrides: Partial<NonNullable<FilesOptions['gemini']>> = {},
) {
  return createFiles({
    env: 'test',
    storage: { root: `${dir}/objects` },
    metadata: { filename: `${dir}/meta.sqlite` },
    processing: { mode: 'sync', spawn: 'never' },
    upload: { chunkBytes: 64 * 1024 },
    gemini: {
      apiKey: 'test-key',
      fetchImpl: gemini.fetchImpl,
      retryDelayMs: 0,
      describeAssets: true,
      ...overrides,
    },
  });
}
