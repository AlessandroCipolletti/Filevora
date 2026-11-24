import { resolveConfig } from '../config/load.js';
import { runDoctor } from '../diagnostics/doctor.js';
import { isFileSdkError } from '../errors/error.js';
import { readManifest } from '../manifest/index.js';

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
  throw new Error(`Unknown tool ${name}.`);
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
