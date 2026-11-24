import type { FileOperation } from '../types/index.js';

export type ManifestMode = 'lite' | 'stored';

export interface HttpRouteSpec {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  name: string;
  operation: FileOperation;
  modes: ManifestMode[];
  auth: 'principal' | 'token';
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

/** Source of truth for public HTTP routes. The handler and the manifest both read this list. */
export const HTTP_ROUTES: HttpRouteSpec[] = [
  {
    method: 'POST',
    path: '/sessions',
    name: 'create-session',
    operation: 'session.create',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      body: {
        filename: 'string',
        mimeType: 'string',
        bytes: 'number',
        checksum: 'string?',
        idempotencyKey: 'string?',
        preset: 'string?',
        metadata: 'Record<string, string>?',
        visibility: 'private | public?',
        webhook: '{ url: string, secret?: string }?',
      },
    },
    response: { status: 201, body: 'UploadSession plus part URLs' },
  },
  {
    method: 'GET',
    path: '/sessions/:sessionId',
    name: 'get-session',
    operation: 'session.read',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { params: { sessionId: 'string' } },
    response: { status: 200, body: 'UploadSession' },
  },
  {
    method: 'PUT',
    path: '/sessions/:sessionId/parts/:partNumber',
    name: 'write-part',
    operation: 'session.write',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      params: { sessionId: 'string', partNumber: 'number' },
      body: 'raw part bytes',
    },
    response: { status: 200, body: '{ etag, partNumber }' },
  },
  {
    method: 'POST',
    path: '/sessions/:sessionId/complete',
    name: 'complete',
    operation: 'session.complete',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      params: { sessionId: 'string' },
      body: '{ checksum?: string }?',
    },
    response: { status: 200, body: 'FileRecord' },
  },
  {
    method: 'POST',
    path: '/sessions/:sessionId/abort',
    name: 'abort',
    operation: 'session.abort',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { params: { sessionId: 'string' } },
    response: { status: 204, body: null },
  },
  {
    method: 'GET',
    path: '/assets',
    name: 'assets',
    operation: 'file.list',
    modes: ['stored'],
    auth: 'principal',
    request: { query: { limit: 'number?', cursor: 'string?' } },
    response: { status: 200, body: '{ assetIds, nextCursor }' },
  },
  {
    method: 'POST',
    path: '/retention/cleanup',
    name: 'cleanup',
    operation: 'retention.run',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { body: '{ dryRun?: boolean }' },
    response: { status: 200, body: 'CleanupReport' },
  },
  {
    method: 'POST',
    path: '/assets/from-url',
    name: 'from-url',
    operation: 'file.import',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      body: {
        url: 'string',
        preset: 'string?',
        webhook: '{ url: string, secret?: string }?',
      },
    },
    response: { status: 202, body: 'FileRecord' },
  },
  {
    method: 'POST',
    path: '/files/batch',
    name: 'batch',
    operation: 'file.read',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { body: { ids: 'string[]' } },
    response: { status: 200, body: 'FileRecord[]' },
  },
  {
    method: 'GET',
    path: '/files',
    name: 'list',
    operation: 'file.list',
    modes: ['stored'],
    auth: 'principal',
    request: { query: { limit: 'number?', cursor: 'string?' } },
    response: { status: 200, body: 'Page<FileRecord>' },
  },
  {
    method: 'GET',
    path: '/files/:fileId',
    name: 'get',
    operation: 'file.read',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { params: { fileId: 'string' } },
    response: { status: 200, body: 'FileRecord' },
  },
  {
    method: 'DELETE',
    path: '/files/:fileId',
    name: 'delete',
    operation: 'file.delete',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { params: { fileId: 'string' } },
    response: { status: 204, body: null },
  },
  {
    method: 'GET',
    path: '/files/:fileId/versions',
    name: 'versions',
    operation: 'delivery.sign',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: { params: { fileId: 'string' } },
    response: { status: 200, body: 'DeliveryResult' },
  },
  {
    method: 'POST',
    path: '/files/:fileId/transform',
    name: 'transform',
    operation: 'process.request',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      params: { fileId: 'string' },
      body: '{ preset?: string, replace?: boolean, operations?: AssetTransformOperation[], webhook?: { url, secret? } }',
    },
    response: {
      status: 202,
      body: '{ launched, jobId, assetId, sourceAssetId, replace }',
    },
  },
  {
    method: 'GET',
    path: '/files/:fileId/progress',
    name: 'progress',
    operation: 'job.read',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      params: { fileId: 'string' },
      headers: { accept: 'application/json | text/event-stream' },
    },
    response: { status: 200, body: 'ProgressEvent' },
  },
  {
    method: 'POST',
    path: '/files/:fileId/delivery',
    name: 'delivery',
    operation: 'delivery.sign',
    modes: ['lite', 'stored'],
    auth: 'principal',
    request: {
      params: { fileId: 'string' },
      body: '{ expiresInSeconds?: number }?',
    },
    response: { status: 200, body: 'DeliveryResult' },
  },
  {
    method: 'GET',
    path: '/content/:token',
    name: 'content',
    operation: 'delivery.sign',
    modes: ['lite', 'stored'],
    auth: 'token',
    request: { params: { token: 'string' } },
    response: { status: 200, body: 'file bytes' },
  },
];

export interface MatchedRoute {
  operation: FileOperation;
  name: string;
  sessionId?: string;
  fileId?: string;
  partNumber?: number;
}

export function matchRoute(
  method: string,
  pathname: string,
): MatchedRoute | null {
  for (const spec of HTTP_ROUTES) {
    if (spec.method !== method || spec.auth === 'token') continue;
    const params = matchPath(spec.path, pathname);
    if (!params) continue;
    const route: MatchedRoute = {
      operation: spec.operation,
      name: spec.name,
    };
    if (params.sessionId) route.sessionId = params.sessionId;
    if (params.fileId) route.fileId = params.fileId;
    if (params.partNumber) route.partNumber = Number(params.partNumber);
    return route;
  }
  return null;
}

function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? '';
    const actual = pathParts[index] ?? '';
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}
