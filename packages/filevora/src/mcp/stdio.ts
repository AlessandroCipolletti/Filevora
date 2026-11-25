import { resolveConfig } from '../config/load.js';
import { runDoctor } from '../diagnostics/doctor.js';
import { fail, isFileSdkError } from '../errors/error.js';
import { readManifest } from '../manifest/index.js';
import {
  descriptionsEnabled,
  parseListQuery,
  type ListQueryInput,
} from '../server/list-query.js';
import { FileService } from '../server/service.js';
import type { SemanticSearchFilesInput } from '../types/index.js';

interface RpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const tools = [
  {
    name: 'manifest_lookup',
    description:
      'Read the Filevora capability manifest, or one catalog section.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description:
            'catalog.exports, catalog.endpoints, catalog.env, catalog.errors, catalog.progress, or features',
        },
      },
    },
  },
  {
    name: 'validate_config',
    description: 'Validate Filevora configuration. Pass env as a string map.',
    inputSchema: {
      type: 'object',
      properties: { env: { type: 'object' } },
    },
  },
  {
    name: 'doctor',
    description: 'Run filevora doctor and return the check report.',
    inputSchema: { type: 'object', properties: { env: { type: 'object' } } },
  },
  {
    name: 'list_files',
    description:
      'Validate GET /files filters and return the query to send. Does not open the database. Description filters need stored mode and FILEVORA_GEMINI_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        env: { type: 'object' },
        query: {
          type: 'object',
          description:
            'type, createdFrom, createdTo, updatedFrom, updatedTo, tags, tagsAll, tagCategory, q, mime, filename, sizeMin, sizeMax, durationMin, durationMax, widthMin, heightMin, status, descriptionStatus, visibility, preset, hasDescription, sort, order, limit, cursor',
        },
      },
    },
  },
  {
    name: 'semantic_search_assets',
    description:
      'Semantic search over described assets in natural language, any language. Runs the search live against FILEVORA_DATABASE_URL with FILEVORA_GEMINI_API_KEY from this process env (or env). Returns { items: [{ score, file }], nextCursor, meta }. Use list_files for exact tag, date, or text filters.',
    inputSchema: {
      type: 'object',
      properties: {
        tenantId: {
          type: 'string',
          description: 'Tenant whose assets are searched. Required.',
        },
        query: { type: 'string', description: '1 to 2000 characters.' },
        type: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['image', 'video', 'document', 'audio'],
          },
        },
        createdFrom: { type: 'string' },
        createdTo: { type: 'string' },
        visibility: { type: 'string', enum: ['public', 'private'] },
        mime: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        tagsAll: { type: 'array', items: { type: 'string' } },
        minScore: {
          type: 'number',
          description:
            'Minimum cosine similarity, 0 to 1. Default FILEVORA_SEMANTIC_SEARCH_MIN_SCORE.',
        },
        maxResults: {
          type: 'number',
          description:
            'Hard cap across all pages, 1 to 1000. Default FILEVORA_SEMANTIC_SEARCH_MAX_RESULTS.',
        },
        limit: { type: 'number', description: 'Page size, 1 to 100.' },
        cursor: {
          type: 'string',
          description: 'nextCursor of the previous page.',
        },
        env: { type: 'object' },
      },
      required: ['tenantId', 'query'],
    },
  },
  {
    name: 'describe_asset',
    description:
      'Say whether Gemini asset descriptions can run for this env, and the POST /files/:assetId/describe contract. Does not call Gemini or upload a file.',
    inputSchema: {
      type: 'object',
      properties: { env: { type: 'object' } },
    },
  },
];

export async function handleMcpMessage(
  message: RpcRequest,
): Promise<Record<string, unknown> | null> {
  if (!message.method || message.method.startsWith('notifications/'))
    return null;
  const id = message.id ?? null;
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'filevora', version: '0.1.0' },
      },
    };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (message.method === 'tools/call') {
    const name = String(message.params?.name ?? '');
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: await runTool(name, args) }],
        },
      };
    } catch (error) {
      const text = isFileSdkError(error)
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : 'Tool failed.';
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError: true },
      };
    }
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method ${message.method}` },
  };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (name === 'manifest_lookup') {
    const manifest = readManifest();
    const section = typeof args.section === 'string' ? args.section : '';
    if (!section) return JSON.stringify(manifest);
    const value = section.split('.').reduce<unknown>((current, key) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[key];
    }, manifest);
    return JSON.stringify(value ?? null);
  }
  const env = isStringRecord(args.env) ? args.env : {};
  if (name === 'validate_config') {
    return JSON.stringify({ ok: true, config: resolveConfig({}, env) });
  }
  if (name === 'doctor') {
    return JSON.stringify(await runDoctor({}, env));
  }
  if (name === 'list_files') {
    const config = resolveConfig({}, env);
    const query = isQueryRecord(args.query) ? args.query : {};
    const parsed = parseListQuery(query, config);
    return JSON.stringify({
      endpoint: 'GET /files',
      descriptions: descriptionsEnabled(config),
      query: parsed,
      examples: [
        'GET /files?type=video&tags=joyful&tagCategory=emotion&createdFrom=2026-10-01&createdTo=2026-10-31',
        'GET /files?type=audio&tagsAll=kind:speech&tagsAll=language:italian',
      ],
    });
  }
  if (name === 'semantic_search_assets') {
    const tenantId = typeof args.tenantId === 'string' ? args.tenantId : '';
    if (!tenantId) {
      throw fail('SEMANTIC_SEARCH_QUERY_INVALID', {
        message: 'tenantId is required: the tenant whose assets are searched.',
      });
    }
    const input: Record<string, unknown> = { ...args };
    delete input.env;
    delete input.tenantId;
    const files = new FileService(
      resolveConfig({}, { ...process.env, ...env }),
    );
    try {
      const page = await files.semanticSearch(
        input as unknown as SemanticSearchFilesInput,
        {
          principal: { id: 'mcp', tenantId },
        },
      );
      return JSON.stringify(page);
    } finally {
      await files.close();
    }
  }
  if (name === 'describe_asset') {
    try {
      const config = resolveConfig({}, env);
      return JSON.stringify({
        ready:
          Boolean(config.gemini.apiKey) && config.metadata.mode === 'stored',
        model: config.gemini.model,
        describeAssets: config.gemini.describeAssets,
        endpoint: 'POST /files/:assetId/describe',
        privacy:
          'When a description runs, a smaller copy of the asset is sent to Google Gemini.',
      });
    } catch (error) {
      const text = isFileSdkError(error)
        ? `${error.code}: ${error.message}`
        : 'DESCRIPTION_NOT_CONFIGURED';
      return JSON.stringify({ ready: false, error: text });
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

function isQueryRecord(value: unknown): value is ListQueryInput {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

/** Speak MCP over stdin/stdout using Content-Length frames. No extra dependency. */
export async function serveMcp(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  for (const message of readFrames(text)) {
    const response = await handleMcpMessage(message);
    if (response) writeFrame(response);
  }
}

function readFrames(text: string): RpcRequest[] {
  const messages: RpcRequest[] = [];
  let rest = text;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      const trimmed = rest.trim();
      if (trimmed) messages.push(JSON.parse(trimmed) as RpcRequest);
      break;
    }
    const header = rest.slice(0, headerEnd);
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    const start = headerEnd + 4;
    messages.push(JSON.parse(rest.slice(start, start + length)) as RpcRequest);
    rest = rest.slice(start + length);
  }
  return messages;
}

function writeFrame(message: Record<string, unknown>): void {
  const body = JSON.stringify(message);
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
