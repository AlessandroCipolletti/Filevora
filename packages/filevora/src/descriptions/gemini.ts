import { redactString } from '../redact.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const INLINE_GEMINI_BYTES = 15 * 1024 * 1024;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    description_long: { type: 'string' },
    description_short: { type: 'string' },
    tags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          tag: { type: 'string' },
        },
        required: ['category', 'tag'],
      },
    },
  },
  required: ['description_long', 'description_short', 'tags'],
};

export interface GeminiTag {
  category: string;
  tag: string;
}

export interface GeminiDescription {
  descriptionLong: string;
  descriptionShort: string;
  tags: GeminiTag[];
}

export interface GeminiRequest {
  apiKey: string;
  model: string;
  mimeType: string;
  bytes: Uint8Array;
  prompt: string;
  inlineMaxBytes?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export async function askGemini(
  input: GeminiRequest,
): Promise<GeminiDescription> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const inlineMax = input.inlineMaxBytes ?? INLINE_GEMINI_BYTES;
  const uploaded =
    input.bytes.byteLength > inlineMax
      ? await uploadFile(input, fetchImpl)
      : undefined;
  try {
    const text = await generate(input, fetchImpl, uploaded?.uri);
    return parseDescription(text);
  } finally {
    if (uploaded) await deleteFile(input, fetchImpl, uploaded.name);
  }
}

async function generate(
  input: GeminiRequest,
  fetchImpl: typeof fetch,
  fileUri: string | undefined,
): Promise<string> {
  const part = fileUri
    ? { fileData: { mimeType: input.mimeType, fileUri } }
    : {
        inlineData: {
          mimeType: input.mimeType,
          data: Buffer.from(input.bytes).toString('base64'),
        },
      };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`;
  const response = await withRetry(input, () =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': input.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: input.prompt }, part] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseJsonSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    }),
  );
  const body = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = body.candidates?.[0]?.content?.parts?.find(
    (part) => part.text,
  )?.text;
  if (!text) {
    throw new Error('Gemini returned no description text.');
  }
  return text;
}

async function uploadFile(
  input: GeminiRequest,
  fetchImpl: typeof fetch,
): Promise<{ name: string; uri: string }> {
  const boundary = `filevora-${Date.now().toString(16)}`;
  const head = Buffer.from(
    `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ file: { displayName: 'filevora-asset' } })}\r\n--${boundary}\r\ncontent-type: ${input.mimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const response = await withRetry(input, () =>
    fetchImpl('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'content-type': `multipart/related; boundary=${boundary}`,
        'x-goog-api-key': input.apiKey,
        'x-goog-upload-protocol': 'multipart',
      },
      body: Buffer.concat([head, Buffer.from(input.bytes), tail]),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    }),
  );
  const body = (await response.json()) as {
    file?: { name?: string; uri?: string };
  };
  if (!body.file?.name || !body.file.uri) {
    throw new Error('Gemini did not return an uploaded file.');
  }
  return { name: body.file.name, uri: body.file.uri };
}

async function deleteFile(
  input: GeminiRequest,
  fetchImpl: typeof fetch,
  name: string,
): Promise<void> {
  const path = name.startsWith('files/') ? name : `files/${name}`;
  await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/${path}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': input.apiKey },
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  }).catch(() => undefined);
}

async function withRetry(
  input: GeminiRequest,
  send: () => Promise<Response>,
): Promise<Response> {
  let last = 'Gemini did not respond.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await send();
    if (response.ok) return response;
    last = `Gemini returned ${response.status}.`;
    if (response.status !== 429 && response.status < 500) break;
    await delay(input.retryDelayMs ?? 200 * 2 ** attempt);
  }
  throw new Error(redactString(last));
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDescription(text: string): GeminiDescription {
  const parsed = JSON.parse(text) as {
    description_long?: unknown;
    description_short?: unknown;
    tags?: unknown;
  };
  if (
    typeof parsed.description_long !== 'string' ||
    typeof parsed.description_short !== 'string' ||
    !Array.isArray(parsed.tags)
  ) {
    throw new Error('Gemini JSON did not match the description schema.');
  }
  const tags: GeminiTag[] = [];
  for (const entry of parsed.tags) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { category?: unknown; tag?: unknown };
    if (typeof record.category !== 'string' || typeof record.tag !== 'string') {
      continue;
    }
    tags.push({ category: record.category, tag: record.tag });
  }
  return {
    descriptionLong: parsed.description_long,
    descriptionShort: parsed.description_short,
    tags,
  };
}
