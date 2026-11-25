import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../dist/cli/main.js';
import { ERROR_CODES } from '../dist/errors/catalog.js';
import { HTTP_ROUTES } from '../dist/http/route-table.js';
import { buildManifest } from '../dist/manifest/build.js';
import { readManifest } from '../dist/manifest/index.js';
import { handleMcpMessage } from '../dist/mcp/stdio.js';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

test('the committed manifest matches the generator', () => {
  const hand = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'docs/agents/capabilities.hand.json'),
      'utf8',
    ),
  );
  const generated = `${JSON.stringify(buildManifest(hand), null, 2)}\n`;
  const committed = readFileSync(
    path.join(repoRoot, 'docs/agents/capabilities.json'),
    'utf8',
  );
  const packaged = readFileSync(
    path.join(repoRoot, 'packages/filevora/capabilities.json'),
    'utf8',
  );
  assert.equal(generated, committed);
  assert.equal(packaged, committed);
  const manifest = readManifest();
  const catalog = manifest.catalog as {
    endpoints: Array<{ method: string; path: string }>;
    errors: Array<{ code: string; cause: string; fix: string }>;
    env: Array<{ key: string; type: string; appliesTo: string }>;
    progress: { fileId: string };
  };
  for (const route of HTTP_ROUTES) {
    assert.ok(
      catalog.endpoints.some(
        (endpoint) =>
          endpoint.method === route.method && endpoint.path === route.path,
      ),
      route.path,
    );
  }
  for (const code of ERROR_CODES) {
    const error = catalog.errors.find((item) => item.code === code);
    assert.ok(error, code);
    assert.equal(typeof error?.cause, 'string');
    assert.equal(typeof error?.fix, 'string');
  }
  assert.ok(catalog.env.some((item) => item.key === 'FILEVORA_DATABASE_URL'));
  assert.equal(
    catalog.env.find((item) => item.key === 'FILEVORA_DATABASE_URL')?.appliesTo,
    'stored',
  );
  assert.equal(catalog.progress.fileId, 'string');
});

test('filevora manifest --json prints the catalog', async () => {
  const lines: string[] = [];
  const code = await runCli(
    ['manifest', '--json'],
    {},
    {
      stdout: (line) => lines.push(line),
      stderr: () => undefined,
    },
  );
  assert.equal(code, 0);
  const body = JSON.parse(lines.join('')) as { schemaVersion: number };
  assert.equal(body.schemaVersion, 2);
});

test('the MCP server lists its tools', async () => {
  const listed = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });
  const names = (
    (listed?.result as { tools: Array<{ name: string }> }).tools ?? []
  ).map((tool) => tool.name);
  assert.deepEqual(names, [
    'manifest_lookup',
    'validate_config',
    'doctor',
    'list_files',
    'search_assets',
    'describe_asset',
  ]);
  const describe = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'describe_asset',
      arguments: { env: { FILES_ENV: 'test' } },
    },
  });
  const describeText = (
    describe?.result as { content: Array<{ text: string }> }
  ).content[0]?.text;
  assert.equal(JSON.parse(describeText ?? '{}').ready, false);
  const lookup = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'manifest_lookup',
      arguments: { section: 'catalog.progress' },
    },
  });
  const text = (lookup?.result as { content: Array<{ text: string }> })
    .content[0]?.text;
  assert.equal(
    JSON.parse(text ?? '{}').phase,
    'upload | download | processing',
  );
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-mcp-'));
  try {
    const validated = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'validate_config',
        arguments: {
          env: {
            FILES_ENV: 'test',
            FILES_STORAGE_ROOT: dir,
            FILES_RUNTIME: 'long-running',
          },
        },
      },
    });
    const configText = (
      validated?.result as { content: Array<{ text: string }> }
    ).content[0]?.text;
    assert.equal(JSON.parse(configText ?? '{}').ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
