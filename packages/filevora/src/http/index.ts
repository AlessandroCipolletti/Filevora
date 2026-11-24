import { createRequestId, fail, isFileSdkError } from '../errors/error.js';
import { mimeAllowed } from '../mime.js';
import type { Files } from '../server/index.js';
import { HTTP_ROUTES, matchRoute, type MatchedRoute } from './route-table.js';
import type {
  FileOperation,
  FileRecord,
  Principal,
  UploadPolicy,
} from '../types/index.js';

export { handleNodeRequest } from './node.js';

export interface FilesHandlerOptions {
  files: Files;
  /** Required. Return null when the request has no application session. */
  authenticate: (request: Request) => Promise<Principal | null>;
  /** Required. Called for every operation except a signed content token fetch. */
  authorize: (input: {
    principal: Principal;
    operation: FileOperation;
    file?: FileRecord | null;
    request: Request;
  }) => Promise<boolean>;
  /** Required. Server-owned limits. Browser fields named ownerId or tenantId are ignored. */
  policy: (input: {
    principal: Principal;
    request: Request;
  }) => Promise<UploadPolicy>;
  /** Path prefix stripped before routing, for example `/api/files`. */
  basePath?: string;
  /**
   * When set, GET of this path returns doctor JSON without authentication.
   * `true` uses `/health`.
   */
  health?: boolean | { path?: string };
}

/**
 * Framework-neutral HTTP adapter. The host authenticates the user.
 * Filevora does not issue accounts or API keys.
 *
 * Browser JSON fields named `ownerId` or `tenantId` are ignored.
 */
export function createFilesHandler(
  options: FilesHandlerOptions,
): (request: Request) => Promise<Response> {
  if (
    !options?.files ||
    typeof options.authenticate !== 'function' ||
    typeof options.authorize !== 'function'
  ) {
    throw fail('INVALID_CONFIG', {
      message:
        'createFilesHandler requires files, authenticate, and authorize.',
    });
  }
  if (typeof options.policy !== 'function') {
    throw fail('INVALID_CONFIG', {
      message: 'createFilesHandler requires a policy callback.',
    });
  }
  const basePath = (options.basePath ?? '').replace(/\/$/, '');

  return async (request) => {
    const requestId = createRequestId();
    try {
      const url = new URL(request.url);
      const pathname = stripBase(url.pathname, basePath);
      const healthPath =
        options.health === true
          ? '/health'
          : options.health
            ? (options.health.path ?? '/health')
            : '';
      if (healthPath && request.method === 'GET' && pathname === healthPath) {
        const { runDoctor } = await import('../diagnostics/doctor.js');
        const { filesOptionsFromResolved } =
          await import('../worker/supervisor.js');
        const report = await runDoctor(
          filesOptionsFromResolved(options.files.config),
        );
        return json(report, report.ok ? 200 : 503, requestId);
      }
      const content = HTTP_ROUTES.find((route) => route.name === 'content');
      if (
        content &&
        request.method === content.method &&
        pathname.startsWith('/content/')
      ) {
        return await sendContent(
          options.files,
          pathname.slice('/content/'.length),
          request,
          requestId,
        );
      }
      const publicMatch = /^\/public\/([^/]+)\/([^/]+)$/.exec(pathname);
      if (request.method === 'GET' && publicMatch?.[1] && publicMatch[2]) {
        return await sendPublic(
          options.files,
          decodeURIComponent(publicMatch[1]),
          decodeURIComponent(publicMatch[2]),
          request,
          requestId,
        );
      }
      const principal = await options.authenticate(request);
      if (!principal?.id || !principal.tenantId)
        throw fail('UNAUTHORIZED', { requestId });
      const route = matchRoute(request.method, pathname);
      if (!route) throw fail('NOT_FOUND', { requestId });
      const allowed = await options.authorize({
        principal,
        operation: route.operation,
        request,
      });
      if (!allowed) throw fail('FORBIDDEN', { requestId });
      return await dispatch(
        options,
        request,
        principal,
        route,
        basePath,
        url.origin,
        requestId,
      );
    } catch (error) {
      const sdk = isFileSdkError(error)
        ? error
        : fail('INVALID_CONFIG', {
            message:
              options.files.config.env === 'test' && error instanceof Error
                ? error.message
                : 'The request failed.',
            requestId,
          });
      const body = sdk.toJSON();
      body.requestId = requestId;
      return json(body, sdk.httpStatus, requestId);
    }
  };
}

type Route = MatchedRoute;

async function dispatch(
  options: FilesHandlerOptions,
  request: Request,
  principal: Principal,
  route: Route,
  basePath: string,
  origin: string,
  requestId: string,
): Promise<Response> {
  const ctx = { principal };
  if (route.name === 'cleanup') {
    const body = asRecord(await readJson(request));
    return json(
      await options.files.retentionSweep({ dryRun: body.dryRun === true }, ctx),
      200,
      requestId,
    );
  }
  if (route.name === 'direct-upload') {
    const body = asRecord(await readJson(request));
    const filename = stringField(body, 'filename');
    const mimeType = stringField(body, 'mimeType');
    const bytes = body.bytes;
    if (!filename || !mimeType || typeof bytes !== 'number') {
      throw fail('INVALID_CONFIG', {
        message: 'filename, mimeType, and bytes are required.',
        requestId,
      });
    }
    const mode =
      body.mode === 'single' || body.mode === 'multipart'
        ? body.mode
        : undefined;
    const preset = stringField(body, 'preset');
    return json(
      await options.files.createDirectUpload(
        {
          filename,
          mimeType,
          bytes,
          ...(mode ? { mode } : {}),
          ...(preset ? { preset } : {}),
          ...(booleanField(body, 'describe') !== undefined
            ? { describe: booleanField(body, 'describe') }
            : {}),
        },
        ctx,
      ),
      201,
      requestId,
    );
  }
  if (route.name === 'direct-complete' && route.sessionId) {
    const body = asRecord(await readJson(request));
    const parts = Array.isArray(body.parts)
      ? body.parts.flatMap((part) => {
          if (!part || typeof part !== 'object') return [];
          const record = part as { partNumber?: unknown; etag?: unknown };
          if (
            typeof record.partNumber !== 'number' ||
            typeof record.etag !== 'string'
          ) {
            return [];
          }
          return [{ partNumber: record.partNumber, etag: record.etag }];
        })
      : undefined;
    return json(
      await options.files.completeDirectUpload(
        route.sessionId,
        {
          ...(parts ? { parts } : {}),
          ...(booleanField(body, 'describe') !== undefined
            ? { describe: booleanField(body, 'describe') }
            : {}),
        },
        ctx,
      ),
      200,
      requestId,
    );
  }
  if (route.name === 'pdf-merge') {
    const body = asRecord(await readJson(request));
    const assetIds = Array.isArray(body.assetIds)
      ? body.assetIds.filter((item): item is string => typeof item === 'string')
      : [];
    return json(
      await options.files.mergePdfs(
        assetIds,
        ctx,
        booleanField(body, 'describe'),
      ),
      202,
      requestId,
    );
  }
  if (route.name === 'pdf-split' && route.fileId) {
    const body = asRecord(await readJson(request));
    const ranges = Array.isArray(body.ranges)
      ? body.ranges.map((range) =>
          Array.isArray(range)
            ? range.filter((page): page is number => typeof page === 'number')
            : [],
        )
      : [];
    return json(
      await options.files.splitPdf(
        route.fileId,
        ranges,
        ctx,
        booleanField(body, 'describe'),
      ),
      202,
      requestId,
    );
  }
  if (route.name === 'describe' && route.fileId) {
    return json(
      await options.files.describeAsset(route.fileId, ctx),
      202,
      requestId,
    );
  }
  if (route.name === 'transform' && route.fileId) {
    const body = await readJson(request);
    return json(
      await options.files.transform(route.fileId, body, ctx),
      202,
      requestId,
    );
  }
  if (route.name === 'from-url') {
    const body = await readJson(request);
    const record = asRecord(body);
    const url = stringField(record, 'url');
    if (!url) {
      throw fail('INVALID_CONFIG', {
        message: 'url is required.',
        requestId,
      });
    }
    const webhook = webhookFrom(record.webhook);
    const preset = stringField(record, 'preset');
    const visibility =
      record.visibility === 'public' || record.visibility === 'private'
        ? record.visibility
        : undefined;
    return json(
      await options.files.createFromUrl(
        {
          url,
          ...(webhook ? { webhook } : {}),
          ...(preset ? { preset } : {}),
          ...(visibility ? { visibility } : {}),
          ...(booleanField(record, 'describe') !== undefined
            ? { describe: booleanField(record, 'describe') }
            : {}),
        },
        ctx,
      ),
      202,
      requestId,
    );
  }
  if (route.name === 'create-session') {
    const body = await readJson(request);
    const record = asRecord(body);
    const filename = stringField(record, 'filename');
    const mimeType = stringField(record, 'mimeType');
    const bytes = numberField(record, 'bytes');
    if (!filename || !mimeType || bytes === undefined) {
      throw fail('INVALID_CONFIG', {
        message: 'filename, mimeType, and bytes are required.',
        requestId,
      });
    }
    const policy = await options.policy({ principal, request });
    const maxFileBytes = Math.min(
      options.files.config.defaults.maxFileBytes,
      policy.maxFileBytes ?? Number.POSITIVE_INFINITY,
    );
    const allowed =
      policy.allowedMimeTypes ?? options.files.config.defaults.allowedMimeTypes;
    if (bytes > maxFileBytes) throw fail('FILE_TOO_LARGE', { requestId });
    if (!mimeAllowed(mimeType.toLowerCase(), allowed))
      throw fail('UNSUPPORTED_MIME', { requestId });
    const session = await options.files.createUploadSession(
      {
        filename,
        mimeType,
        bytes,
        ...(typeof record.checksum === 'string'
          ? { checksum: record.checksum }
          : {}),
        ...(typeof record.idempotencyKey === 'string'
          ? { idempotencyKey: record.idempotencyKey }
          : {}),
        ...(typeof record.preset === 'string' ? { preset: record.preset } : {}),
        ...(booleanField(record, 'describe') !== undefined
          ? { describe: booleanField(record, 'describe') }
          : {}),
        ...(record.metadata && typeof record.metadata === 'object'
          ? { metadata: record.metadata as Record<string, string> }
          : {}),
        ...(record.visibility === 'public' || record.visibility === 'private'
          ? { visibility: record.visibility }
          : {}),
        ...(webhookFrom(record.webhook)
          ? { webhook: webhookFrom(record.webhook) }
          : {}),
      },
      { principal, ...(policy.ownerId ? { ownerId: policy.ownerId } : {}) },
    );
    const prefix = `${origin}${basePath}`;
    return json(
      {
        ...session,
        partUrlTemplate: `${prefix}/sessions/${session.id}/parts/{partNumber}`,
        completeUrl: `${prefix}/sessions/${session.id}/complete`,
        partUrls: await options.files.partUploadUrls(session.id, { principal }),
      },
      201,
      requestId,
    );
  }
  if (route.name === 'get-session' && route.sessionId) {
    return json(
      await options.files.getUploadSession(route.sessionId, ctx),
      200,
      requestId,
    );
  }
  if (route.name === 'write-part' && route.sessionId && route.partNumber) {
    const session = await options.files.getUploadSession(route.sessionId, ctx);
    const body = await readBytes(request, session.partSize);
    const part = await options.files.writePart(
      route.sessionId,
      route.partNumber,
      body,
      ctx,
    );
    return json(part, 200, requestId, { etag: part.etag });
  }
  if (route.name === 'complete' && route.sessionId) {
    const body = await readJson(request).catch(() => ({}));
    const record = asRecord(body);
    const file = await options.files.completeUpload(
      route.sessionId,
      {
        ...(Array.isArray(record.parts)
          ? {
              parts: record.parts as Array<{
                partNumber: number;
                etag: string;
              }>,
            }
          : {}),
        ...(typeof record.checksum === 'string'
          ? { checksum: record.checksum }
          : {}),
      },
      ctx,
    );
    return json({ file }, 200, requestId);
  }
  if (route.name === 'abort' && route.sessionId) {
    await options.files.abortUpload(route.sessionId, ctx);
    return json({ aborted: true }, 200, requestId);
  }
  if (route.name === 'assets') {
    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const page = await options.files.listAssetIds(
      {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(cursor ? { cursor } : {}),
      },
      ctx,
    );
    return json(page, 200, requestId);
  }
  if (route.name === 'list') {
    const url = new URL(request.url);
    const limit = url.searchParams.get('limit');
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const kind = url.searchParams.get('kind') ?? undefined;
    const status = url.searchParams.get('status') ?? undefined;
    const createdAfter = url.searchParams.get('createdAfter') ?? undefined;
    const tag = url.searchParams.get('tag') ?? undefined;
    const page = await options.files.list(
      {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(cursor ? { cursor } : {}),
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
        ...(createdAfter ? { createdAfter } : {}),
        ...(tag ? { tag } : {}),
      },
      ctx,
    );
    return json(page, 200, requestId);
  }
  if (route.name === 'batch') {
    const body = (await request.json().catch(() => ({}))) as {
      assetIds?: string[];
    };
    const ids = Array.isArray(body.assetIds) ? body.assetIds : [];
    if (options.files.config.metadata.mode === 'lite' && ids.length > 20) {
      throw fail('FEATURE_REQUIRES_STORED_MODE', {
        message: 'Lite batch get is capped at 20 asset ids.',
        context: { mode: 'lite', cap: 20 },
      });
    }
    const assets = [];
    for (const id of ids) {
      try {
        assets.push(
          await options.files.get(id, ctx, { detailed: ids.length <= 20 }),
        );
      } catch (error) {
        if (!isFileSdkError(error) || error.code !== 'ASSET_NOT_FOUND')
          throw error;
      }
    }
    return json({ assets }, 200, requestId);
  }
  if (route.name === 'get' && route.fileId) {
    const detailed =
      options.files.config.metadata.mode === 'stored' ||
      new URL(request.url).searchParams.get('detailed') === 'true';
    return json(
      await options.files.get(route.fileId, ctx, { detailed }),
      200,
      requestId,
    );
  }
  if (route.name === 'delete' && route.fileId) {
    await options.files.delete(route.fileId, ctx);
    return json({ deleted: true }, 200, requestId);
  }
  if (route.name === 'progress' && route.fileId) {
    const wantsJson = (request.headers.get('accept') ?? '').includes(
      'application/json',
    );
    if (wantsJson) {
      return json(
        await options.files.processingSnapshot(route.fileId, ctx, {
          baseUrl: `${origin}${basePath}`,
        }),
        200,
        requestId,
      );
    }
    const fileId = route.fileId;
    const encoder = new TextEncoder();
    let closed = false;
    const stream = new ReadableStream({
      async start(controller) {
        let previous = '';
        try {
          for (;;) {
            const snapshot = await options.files.processingSnapshot(
              fileId,
              ctx,
              { baseUrl: `${origin}${basePath}` },
            );
            const line = JSON.stringify(snapshot);
            const emit = !snapshot.quiet || snapshot.terminal;
            if (emit && line !== previous) {
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
              previous = line;
            }
            if (snapshot.terminal) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'progress failed';
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ message })}\n\n`,
            ),
          );
        } finally {
          if (!closed) controller.close();
        }
      },
      cancel() {
        closed = true;
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'x-request-id': requestId,
      },
    });
  }
  if (route.name === 'versions' && route.fileId) {
    return json(
      await options.files.getDeliveryUrls(
        route.fileId,
        { baseUrl: `${origin}${basePath}` },
        ctx,
      ),
      200,
      requestId,
    );
  }
  if (route.name === 'visibility' && route.fileId) {
    const body = await readJson(request);
    const record = asRecord(body);
    const visibility = record.visibility;
    if (visibility !== 'public' && visibility !== 'private') {
      throw fail('INVALID_CONFIG', {
        message: 'visibility must be public or private.',
        requestId,
      });
    }
    return json(
      await options.files.setVisibility(route.fileId, visibility, ctx),
      200,
      requestId,
    );
  }
  if (route.name === 'revoke-urls' && route.fileId) {
    return json(
      await options.files.revokeUrls(route.fileId, ctx),
      200,
      requestId,
    );
  }
  if (route.name === 'delivery' && route.fileId) {
    const body = await readJson(request).catch(() => ({}));
    const record = asRecord(body);
    const expires =
      typeof record.expiresInSeconds === 'number'
        ? record.expiresInSeconds
        : undefined;
    const delivery = await options.files.getDeliveryUrls(
      route.fileId,
      {
        baseUrl: `${origin}${basePath}`,
        ...(expires ? { expiresInSeconds: expires } : {}),
      },
      ctx,
    );
    return json(delivery, 200, requestId);
  }
  throw fail('NOT_FOUND', { requestId });
}

async function sendContent(
  files: Files,
  token: string,
  request: Request,
  requestId: string,
): Promise<Response> {
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const opened = await files.openOriginal(
    decodeURIComponent(token),
    range,
    clientIp(request),
  );
  const headers = new Headers({
    'content-type': opened.contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, no-store',
    'content-disposition': `attachment; filename="${opened.fileName.replace(/"/g, '')}"`,
    'accept-ranges': 'bytes',
    'x-request-id': requestId,
  });
  if (range) {
    headers.set(
      'content-range',
      `bytes ${opened.start}-${opened.end}/${opened.total}`,
    );
    headers.set('content-length', String(opened.end - opened.start + 1));
    const bytes =
      opened.body instanceof Uint8Array ? opened.body : new Uint8Array();
    return new Response(bytes, { status: 206, headers });
  }
  headers.set('content-length', String(opened.total));
  const stream =
    opened.body instanceof Uint8Array
      ? new Response(opened.body).body
      : opened.body;
  return new Response(stream, { status: 200, headers });
}

function clientIp(request: Request): string | undefined {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() || undefined;
  return request.headers.get('x-real-ip') ?? undefined;
}

async function sendPublic(
  files: Files,
  assetId: string,
  version: string,
  request: Request,
  requestId: string,
): Promise<Response> {
  const rangeHeader = request.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader) : undefined;
  const opened = await files.openPublic(assetId, version, range);
  const headers = new Headers({
    'content-type': opened.contentType,
    'x-content-type-options': 'nosniff',
    'cache-control': 'public, max-age=60',
    'content-disposition': `inline; filename="${opened.fileName.replace(/"/g, '')}"`,
    'accept-ranges': 'bytes',
    'x-request-id': requestId,
  });
  if (range) {
    headers.set(
      'content-range',
      `bytes ${opened.start}-${opened.end}/${opened.total}`,
    );
    headers.set('content-length', String(opened.end - opened.start + 1));
    const bytes =
      opened.body instanceof Uint8Array ? opened.body : new Uint8Array();
    return new Response(bytes, { status: 206, headers });
  }
  headers.set('content-length', String(opened.total));
  const stream =
    opened.body instanceof Uint8Array
      ? new Response(opened.body).body
      : opened.body;
  return new Response(stream, { status: 200, headers });
}

function parseRange(header: string): { start: number; end?: number } {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match?.[1])
    throw fail('INVALID_CONFIG', {
      message: 'The requested byte range is outside the object.',
    });
  return {
    start: Number(match[1]),
    ...(match[2] ? { end: Number(match[2]) } : {}),
  };
}

function stripBase(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return '/';
  if (pathname.startsWith(`${basePath}/`))
    return pathname.slice(basePath.length);
  return pathname;
}

async function readBytes(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!request.body) throw fail('UPLOAD_SIZE_MISMATCH');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw fail('FILE_TOO_LARGE');
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readJson(request: Request): Promise<unknown> {
  const bytes = await readBytes(request, 1_000_000);
  if (bytes.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw fail('INVALID_CONFIG', { message: 'The request body is not JSON.' });
  }
}

function webhookFrom(
  value: unknown,
): { url: string; secret?: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string') return undefined;
  return {
    url: record.url,
    ...(typeof record.secret === 'string' ? { secret: record.secret } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function booleanField(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  if (record[key] === true || record[key] === false) return record[key];
  return undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof record[key] === 'number' ? record[key] : undefined;
}

function json(
  body: unknown,
  status: number,
  requestId: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': requestId,
      ...extra,
    },
  });
}
