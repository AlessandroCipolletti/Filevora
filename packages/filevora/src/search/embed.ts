import type { ResolvedConfig } from '../config/load.js';
import { withRetry } from '../descriptions/gemini.js';
import { fail, isFileSdkError } from '../errors/error.js';
import { sha256 } from '../ids.js';
import { redactString } from '../redact.js';

export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

export interface EmbedConfig {
  apiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
}

export function embedConfigFrom(config: ResolvedConfig): EmbedConfig {
  const { gemini } = config;
  return {
    apiKey: gemini.apiKey,
    embeddingModel: gemini.embeddingModel,
    embeddingDimensions: gemini.embeddingDimensions,
    retryDelayMs: gemini.retryDelayMs,
    ...(gemini.fetchImpl ? { fetchImpl: gemini.fetchImpl } : {}),
  };
}

/** Scale to unit length and pack as little-endian IEEE-754 float32. */
export function normalizeToFloat32Bytes(
  values: number[],
  expectedDim: number,
): Uint8Array {
  if (values.length !== expectedDim) {
    throw fail('EMBEDDING_UNAVAILABLE', {
      message: `Gemini returned ${values.length} dimensions; expected ${expectedDim}.`,
    });
  }
  let sumSq = 0;
  for (let i = 0; i < expectedDim; i += 1) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) {
      throw fail('EMBEDDING_UNAVAILABLE', {
        message: 'Gemini returned a non-finite embedding value.',
      });
    }
    sumSq += v * v;
  }
  if (sumSq <= 0) {
    throw fail('EMBEDDING_UNAVAILABLE', {
      message: 'Gemini returned a zero-norm embedding vector.',
    });
  }
  const invNorm = 1 / Math.sqrt(sumSq);
  const out = new Uint8Array(expectedDim * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < expectedDim; i += 1) {
    view.setFloat32(i * 4, Number(values[i]) * invNorm, true);
  }
  return out;
}

/** Decode packed little-endian float32 bytes into a Float32Array, copying when misaligned. */
export function toFloat32(bytes: Uint8Array): Float32Array {
  const length = bytes.byteLength / 4;
  if ((bytes.byteOffset & 3) === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, length);
  }
  const copy = new Float32Array(length);
  new Uint8Array(copy.buffer).set(bytes);
  return copy;
}

const TAG_ORDER = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

export interface CanonicalEmbeddingInput {
  assetType: string;
  mime: string;
  originalName: string;
  descriptionShort: string;
  descriptionLong: string;
  tags: Array<{ category: string; tag: string }>;
}

/** Deterministic document text so the same description always embeds the same way. */
export function buildCanonicalEmbeddingText(input: CanonicalEmbeddingInput): {
  title: string;
  text: string;
  contentHash: string;
} {
  const title = input.originalName.trim().slice(0, 200);
  const byCategory = new Map<string, string[]>();
  for (const entry of input.tags) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry.tag);
    byCategory.set(entry.category, list);
  }
  const groupedTags = [...byCategory.keys()].sort(TAG_ORDER).map((category) => {
    const tags = [...(byCategory.get(category) ?? [])].sort(TAG_ORDER);
    return `${category}: ${tags.join(', ')}`;
  });
  const text = [
    `Asset type: ${input.assetType} (${input.mime})`,
    input.descriptionShort.trim(),
    input.descriptionLong.trim(),
    ...(groupedTags.length > 0 ? [`Tags: ${groupedTags.join('; ')}`] : []),
  ]
    .filter((line) => line.length > 0)
    .join('\n\n');
  return {
    title,
    text,
    contentHash: sha256(Buffer.from(`${title}\n${text}`, 'utf8')),
  };
}

function embedRequestBody(
  config: EmbedConfig,
  input: { text: string; task: EmbedTask; title?: string },
): Record<string, unknown> {
  const base = {
    model: `models/${config.embeddingModel}`,
    outputDimensionality: config.embeddingDimensions,
  };
  // gemini-embedding-2 has no taskType field; the task goes into the text.
  if (/^gemini-embedding-2/.test(config.embeddingModel)) {
    const text =
      input.task === 'RETRIEVAL_QUERY'
        ? `task: search result | query: ${input.text}`
        : `title: ${input.title || 'none'} | text: ${input.text}`;
    return { ...base, content: { parts: [{ text }] } };
  }
  return {
    ...base,
    content: { parts: [{ text: input.text }] },
    taskType: input.task,
    ...(input.task === 'RETRIEVAL_DOCUMENT' && input.title
      ? { title: input.title }
      : {}),
  };
}

/** Embed one text with Gemini and return a unit-length little-endian float32 vector. */
export async function embedText(
  config: EmbedConfig,
  input: { text: string; task: EmbedTask; title?: string },
): Promise<Uint8Array> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.embeddingModel)}:embedContent`;
  try {
    const response = await withRetry(config, () =>
      fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(embedRequestBody(config, input)),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    const body = (await response.json()) as {
      embedding?: { values?: unknown };
    };
    const values = body.embedding?.values;
    if (!Array.isArray(values)) {
      throw new Error('Gemini returned no embedding values.');
    }
    return normalizeToFloat32Bytes(
      values as number[],
      config.embeddingDimensions,
    );
  } catch (error) {
    if (isFileSdkError(error)) throw error;
    const detail = error instanceof Error ? error.message : 'Unknown failure.';
    throw fail('EMBEDDING_UNAVAILABLE', {
      message: `The embedding call failed: ${redactString(detail)} Retry with backoff.`,
    });
  }
}
