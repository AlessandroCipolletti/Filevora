import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type AppFramework = 'express' | 'fastify' | 'hono' | 'next' | 'node';
export type PackageManager = 'pnpm' | 'yarn' | 'npm';

export interface InitPlan {
  framework: AppFramework;
  packageManager: PackageManager;
  mode: 'lite' | 'stored';
  files: Array<{ path: string; contents: string }>;
  migration: string;
}

const HANDLER = {
  express: `import express from 'express';
import { createFiles } from 'filevora/server';
import { createFilesHandler, handleNodeRequest } from 'filevora/http';

const files = createFiles();
const handler = createFilesHandler({
  files,
  health: true,
  basePath: '/api/files',
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

export const filevoraRouter = express.Router();
filevoraRouter.use((req, res) => {
  void handleNodeRequest(handler, req, res);
});
`,
  fastify: `import type { FastifyInstance } from 'fastify';
import { createFiles } from 'filevora/server';
import { createFilesHandler, handleNodeRequest } from 'filevora/http';

const files = createFiles();
const handler = createFilesHandler({
  files,
  health: true,
  basePath: '/api/files',
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

export async function filevoraPlugin(app: FastifyInstance) {
  app.all('/*', async (request, reply) => {
    reply.hijack();
    await handleNodeRequest(handler, request.raw, reply.raw);
  });
}
`,
  hono: `import { Hono } from 'hono';
import { createFiles } from 'filevora/server';
import { createFilesHandler } from 'filevora/http';

const files = createFiles();
const handler = createFilesHandler({
  files,
  health: true,
  basePath: '/api/files',
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

export const filevoraApp = new Hono();
filevoraApp.all('/*', (context) => handler(context.req.raw));
`,
  next: `import { createFiles } from 'filevora/server';
import { createFilesHandler } from 'filevora/http';

const files = createFiles();
const handler = createFilesHandler({
  files,
  health: true,
  basePath: '/api/files',
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
`,
  node: `import http from 'node:http';
import { createFiles } from 'filevora/server';
import { createFilesHandler, handleNodeRequest } from 'filevora/http';

const files = createFiles();
const handler = createFilesHandler({
  files,
  health: true,
  basePath: '/api/files',
  async authenticate(request) {
    const id = request.headers.get('x-user');
    const tenantId = request.headers.get('x-tenant');
    if (!id || !tenantId) return null;
    return { id, tenantId };
  },
  async authorize() {
    return true;
  },
  async policy() {
    return {};
  },
});

http.createServer((req, res) => {
  handleNodeRequest(handler, req, res).catch(() => {
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  });
}).listen(8787);
`,
} as const;

const CLIENT = `import { createUploadClient } from 'filevora/client';

const client = createUploadClient({
  endpoint: '/api/files',
  headers: async () => ({ 'x-user': 'user', 'x-tenant': 'tenant' }),
});

export async function uploadFile(file: File) {
  const task = client.upload(file);
  return task.complete();
}
`;

export function detectFramework(dir: string): AppFramework {
  const pkg = readPackage(dir);
  const names = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  if (names.has('next')) return 'next';
  if (names.has('fastify')) return 'fastify';
  if (names.has('hono')) return 'hono';
  if (names.has('express')) return 'express';
  return 'node';
}

export function detectPackageManager(dir: string): PackageManager {
  const pkg = readPackage(dir);
  const declared = pkg.packageManager ?? '';
  if (declared.startsWith('pnpm')) return 'pnpm';
  if (declared.startsWith('yarn')) return 'yarn';
  if (declared.startsWith('npm')) return 'npm';
  if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return 'npm';
}

export function planInit(input: {
  dir: string;
  framework?: AppFramework;
  mode: 'lite' | 'stored';
  databaseUrl?: string;
}): InitPlan {
  const framework = input.framework ?? detectFramework(input.dir);
  const packageManager = detectPackageManager(input.dir);
  const env = envTemplate(input.mode, input.databaseUrl);
  const migration =
    input.mode === 'stored'
      ? `${packageManager === 'npm' ? 'npx' : packageManager} filevora migrate`
      : 'Lite mode does not create a database. No migration is required.';
  return {
    framework,
    packageManager,
    mode: input.mode,
    migration,
    files: [
      {
        path: path.join(input.dir, 'filevora', 'handler.ts'),
        contents: HANDLER[framework],
      },
      {
        path: path.join(input.dir, 'filevora', 'upload-snippet.ts'),
        contents: CLIENT,
      },
      {
        path: path.join(input.dir, '.env.filevora.example'),
        contents: env,
      },
    ],
  };
}

export function applyInit(
  plan: InitPlan,
  force: boolean,
): { written: string[]; skipped: string[] } {
  const existing = plan.files
    .map((file) => file.path)
    .filter((file) => existsSync(file));
  if (existing.length > 0 && !force) {
    const error = new Error(
      `Refusing to overwrite ${existing.join(', ')}. Pass --force to replace them.`,
    );
    error.name = 'INIT_EXISTS';
    throw error;
  }
  for (const file of plan.files) {
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
  }
  return { written: plan.files.map((file) => file.path), skipped: [] };
}

function envTemplate(mode: 'lite' | 'stored', databaseUrl?: string): string {
  const lines = [
    'FILES_ENV=development',
    'FILES_STORAGE_DRIVER=filesystem',
    'FILES_STORAGE_ROOT=./.files/objects',
    'REDIS_URL=redis://127.0.0.1:6379',
    'FILES_DEFAULT_PRESET=web-optimized',
    'FILES_THUMBNAIL_WIDTH=480',
    'FILEVORA_DEFAULT_VISIBILITY=private',
    'FILEVORA_SIGNING_SECRET=replace-with-a-long-random-string',
  ];
  if (mode === 'stored') {
    lines.push(
      'FILEVORA_METADATA_MODE=stored',
      `FILEVORA_DATABASE_URL=${databaseUrl ?? 'postgres://user:password@127.0.0.1:5432/app'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function readPackage(dir: string): {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
} {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      packageManager?: string;
    };
  } catch {
    return {};
  }
}
