import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planInit } from '../dist/cli/init-app.js';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('init templates compile against the client base path', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'filevora-init-compile-'));
  try {
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    symlinkSync(packageRoot, path.join(dir, 'node_modules/filevora'));
    const typesNode = path.join(packageRoot, 'node_modules/@types/node');
    mkdirSync(path.join(dir, 'node_modules/@types'), { recursive: true });
    symlinkSync(typesNode, path.join(dir, 'node_modules/@types/node'));
    writeStub(dir, 'express', expressStub);
    writeStub(dir, 'fastify', fastifyStub);
    writeStub(dir, 'hono', honoStub);
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'es2022',
            module: 'nodenext',
            moduleResolution: 'nodenext',
            strict: true,
            skipLibCheck: true,
            noEmit: true,
            types: ['node'],
          },
          include: ['handlers/**/*.ts'],
        },
        null,
        2,
      ),
    );
    for (const framework of [
      'express',
      'fastify',
      'hono',
      'next',
      'node',
    ] as const) {
      const plan = planInit({ dir, framework, mode: 'lite' });
      const handler = plan.files.find((file) =>
        file.path.endsWith('handler.ts'),
      );
      const snippet = plan.files.find((file) =>
        file.path.endsWith('upload-snippet.ts'),
      );
      assert.ok(handler);
      assert.ok(snippet);
      assert.match(handler.contents, /basePath: '\/api\/files'/);
      assert.match(snippet.contents, /endpoint: '\/api\/files'/);
      if (framework === 'fastify') {
        assert.match(handler.contents, /reply\.hijack\(\)/);
        assert.match(handler.contents, /app: FastifyInstance/);
      }
      const folder = path.join(dir, 'handlers', framework);
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'handler.ts'), handler.contents);
      writeFileSync(path.join(folder, 'upload-snippet.ts'), snippet.contents);
    }
    const tsc = spawnSync(
      process.execPath,
      [
        require.resolve('typescript/bin/tsc'),
        '--project',
        path.join(dir, 'tsconfig.json'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeStub(dir: string, name: string, types: string): void {
  const folder = path.join(dir, 'node_modules', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', types: './index.d.ts' }),
  );
  writeFileSync(path.join(folder, 'index.d.ts'), types);
}

const expressStub = `import type { IncomingMessage, ServerResponse } from 'node:http';
declare function express(): unknown;
declare namespace express {
  interface Router {
    use(handler: (req: IncomingMessage, res: ServerResponse) => void): void;
  }
  function Router(): Router;
}
export default express;
`;

const fastifyStub = `import type { IncomingMessage, ServerResponse } from 'node:http';
export interface FastifyRequest {
  raw: IncomingMessage;
}
export interface FastifyReply {
  raw: ServerResponse;
  hijack(): void;
}
export interface FastifyInstance {
  all(
    path: string,
    handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
  ): void;
}
`;

const honoStub = `export class Hono {
  all(
    path: string,
    handler: (context: { req: { raw: Request } }) => Response | Promise<Response>,
  ): void;
}
`;
