import type { ResolvedConfig } from '../config/load.js';
import { GeminiHttpError, withRetry } from '../descriptions/gemini.js';
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

/** Accept `gemini-embedding-2` or the resource form `models/gemini-embedding-2`. */
function modelId(config: EmbedConfig): string {
  return config.embeddingModel.trim().replace(/^models\//, '');
}

/** Text parts are clipped well below the 8192-token request limit shared with the file. */
export const EMBED_TEXT_MAX_CHARS = 8000;

export interface EmbedFile {
  bytes: Uint8Array;
  mime: string;
}

export type EmbeddingSource = 'file+description' | 'description';

export interface EmbedInput {
  text: string;
  task: EmbedTask;
  title?: string;
  file?: EmbedFile;
}

/**
 * gemini-embedding-2 has no taskType field. Text-only requests carry the task as a prefix;
 * with a file, the description and the file bytes are two parts of one content and embed together.
 */
export function embedRequestBody(
  config: EmbedConfig,
  input: EmbedInput,
): Record<string, unknown> {
  const text = input.text.slice(0, EMBED_TEXT_MAX_CHARS);
  const parts: Array<Record<string, unknown>> = input.file
    ? [
        { text },
        {
          inline_data: {
            mime_type: input.file.mime,
            data: Buffer.from(input.file.bytes).toString('base64'),
          },
        },
      ]
    : [
        {
          text:
            input.task === 'RETRIEVAL_QUERY'
              ? `task: search result | query: ${text}`
              : `title: ${input.title || 'none'} | text: ${text}`,
        },
      ];
  return {
    model: `models/${modelId(config)}`,
    content: { parts },
    output_dimensionality: config.embeddingDimensions,
  };
}

/** Embed one text, or a description together with its file, and return a unit-length float32 vector. */
export async function embedText(
  config: EmbedConfig,
  input: EmbedInput,
): Promise<Uint8Array> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId(config))}:embedContent`;
  try {
    const response = await withRetry(config, () =>
      fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.apiKey,
        },
        body: JSON.stringify(embedRequestBody(config, input)),
        signal: AbortSignal.timeout(input.file ? 90_000 : 30_000),
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
    if (error instanceof GeminiHttpError) {
      throw embeddingHttpFailure(error, config.apiKey);
    }
    const detail = error instanceof Error ? error.message : 'Unknown failure.';
    throw fail('EMBEDDING_UNAVAILABLE', {
      message: `The embedding call failed: ${redactString(detail)} Retry with backoff.`,
    });
  }
}

const PERMANENT_HINTS: Record<number, string> = {
  400: 'Google rejected the request. This is usually an invalid or missing API key (reason API_KEY_INVALID): check FILEVORA_GEMINI_API_KEY. If Google names a field instead, check FILEVORA_EMBEDDING_MODEL and FILEVORA_EMBEDDING_DIMENSIONS.',
  401: 'The API key is missing or invalid. Check FILEVORA_GEMINI_API_KEY.',
  402: 'Billing is not enabled or the account has no credit. Enable billing or add credit for the Gemini API project that owns FILEVORA_GEMINI_API_KEY.',
  403: 'The key has no permission for this model, or the Generative Language API is not enabled for its project. Enable the API, lift any key restriction, or check FILEVORA_EMBEDDING_MODEL.',
};

function embeddingHttpFailure(error: GeminiHttpError, apiKey: string) {
  const scrub = (value: string | undefined) =>
    value && apiKey ? value.split(apiKey).join('[redacted]') : value;
  const googleMessage = scrub(error.googleMessage);
  const googleStatus = scrub(error.googleStatus);
  const googleReason = scrub(error.googleReason);
  const hint = PERMANENT_HINTS[error.httpStatus];
  const retryable = error.httpStatus === 429 || error.httpStatus >= 500;
  const label = [error.httpStatus, googleStatus].filter(Boolean).join(' ');
  const cause = googleMessage ? `: ${googleMessage}` : '.';
  const advice = hint
    ? `${hint} Do not retry until this is fixed.`
    : retryable
      ? 'Retry with backoff.'
      : 'Check FILEVORA_EMBEDDING_MODEL. Do not retry unchanged.';
  return fail('EMBEDDING_UNAVAILABLE', {
    message: `Gemini embedding failed with ${label}${cause} ${advice}`,
    retryable,
    context: {
      geminiHttpStatus: error.httpStatus,
      ...(googleStatus ? { geminiStatus: googleStatus } : {}),
      ...(googleMessage ? { geminiMessage: googleMessage } : {}),
      ...(googleReason ? { geminiReason: googleReason } : {}),
    },
  });
}

/** Google rejected the payload itself (unreadable or oversized media), not the key or the quota. */
function mediaRejected(error: unknown): boolean {
  if (!isFileSdkError(error)) return false;
  const status = error.context?.geminiHttpStatus;
  const reason = error.context?.geminiReason;
  return (status === 400 || status === 413) && reason !== 'API_KEY_INVALID';
}

/**
 * Embed a described asset. With a file the vector covers file and description; when Google
 * refuses the file the description alone is embedded, and the returned source says which happened.
 */
export async function embedDocument(
  config: EmbedConfig,
  input: { text: string; title?: string; file?: EmbedFile },
  log: (message: string) => void = () => undefined,
): Promise<{ vector: Uint8Array; source: EmbeddingSource }> {
  const base = {
    text: input.text,
    task: 'RETRIEVAL_DOCUMENT' as const,
    ...(input.title ? { title: input.title } : {}),
  };
  if (input.file) {
    try {
      const vector = await embedText(config, { ...base, file: input.file });
      return { vector, source: 'file+description' };
    } catch (error) {
      if (!mediaRejected(error)) throw error;
      log(
        `Google rejected the ${input.file.mime} file (${redactString(error instanceof Error ? error.message : 'unknown')}); embedding the description only.`,
      );
    }
  }
  return { vector: await embedText(config, base), source: 'description' };
}
