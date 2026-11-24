import { ERROR_CODES, type ErrorCode } from '../errors/catalog.js';
import { FileSdkError, fail } from '../errors/error.js';
import { type ProcessingUpdate, readEventStream } from './progress-stream.js';
import {
  createIndexedDbResumeStore,
  createMemoryResumeStore,
  type ResumeRecord,
  type ResumeStore,
  resumeKey,
} from './resume-store.js';

export interface UploadProgress {
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
}

export type UploadState =
  'queued' | 'uploading' | 'paused' | 'completed' | 'cancelled' | 'failed';

export interface UploadClientOptions {
  /** Base URL of `createFilesHandler`, for example `/api/files` or `https://app.example/api/files`. */
  endpoint: string;
  fetch?: typeof fetch;
  headers?: HeaderSource | (() => HeaderSource | Promise<HeaderSource>);
  partConcurrency?: number;
  fileConcurrency?: number;
  retry?: { maxAttempts?: number; baseDelayMs?: number };
  resumeStore?: ResumeStore;
  progress?: { channel?: 'sse' | 'poll'; pollMs?: number };
}

export interface UploadOptions {
  preset?: string;
  metadata?: Record<string, string>;
  resume?: {
    enabled?: boolean;
    strategy?: 'indexeddb' | 'memory';
    persistBlob?: 'never' | 'auto' | 'always';
    maxPersistedBytes?: number;
  };
  checksum?: string;
  webhook?: { url: string; secret?: string };
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}

export interface HistoryVariant {
  name: string;
  url: string;
  mimeType: string;
}

export interface UploadHistoryItem {
  localId: string;
  filename: string;
  status: UploadState;
  bytesUploaded: number;
  totalBytes: number;
  percentage: number;
  fileId?: string;
  originalUrl?: string;
  variants?: HistoryVariant[];
}

export interface UploadHistory {
  inFlight: UploadHistoryItem[];
  sinceLoad: UploadHistoryItem[];
  completed: UploadHistoryItem[];
}

export interface UploadTask {
  readonly state: UploadState;
  on(event: 'progress', listener: (progress: UploadProgress) => void): void;
  on(event: 'state', listener: (state: UploadState) => void): void;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  /** Resolves when the upload is verified. Processing may still be pending. */
  complete(): Promise<UploadedFile>;
}

export interface UploadedFile {
  id: string;
  checksum: string | null;
  bytes: number;
  uploadState: string;
  processingState: string;
  originalName: string;
  detectedMime: string | null;
}

type HeaderSource = Headers | Record<string, string> | Array<[string, string]>;

type ListenerMap = {
  progress: Set<(progress: UploadProgress) => void>;
  state: Set<(state: UploadState) => void>;
};

interface SessionResponse extends ResumeRecord {
  id: string;
  status: string;
  receivedParts: Array<{ partNumber: number; bytes: number }>;
  partUrls?: Record<string, string>;
}

/**
 * Browser upload helper. This module does not import Node or storage credentials.
 *
 * `complete()` means the original bytes are stored. It does not mean a
 * derivative has been produced. Use `waitForProcessing` for that.
 */
export function createUploadClient(options: UploadClientOptions) {
  if (!options?.endpoint)
    throw fail('INVALID_CONFIG', {
      message: 'createUploadClient requires an endpoint.',
    });
  const endpoint = options.endpoint.replace(/\/$/, '');
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const partConcurrency = options.partConcurrency ?? 4;
  const fileConcurrency = options.fileConcurrency ?? 3;
  const maxAttempts = options.retry?.maxAttempts ?? 5;
  const baseDelayMs = options.retry?.baseDelayMs ?? 10;
  const gate = createGate(fileConcurrency);
  const progressChannel = options.progress?.channel ?? 'sse';
  const progressPollMs = options.progress?.pollMs ?? 1000;
  let store = options.resumeStore;
  const sinceLoad: UploadHistoryItem[] = [];
  const rememberVersions = (fileId: string, update: ProcessingUpdate) => {
    const versions = update.versions;
    if (!versions) return;
    const item = sinceLoad.find((entry) => entry.fileId === fileId);
    if (!item) return;
    item.originalUrl = versions._original?.url;
    item.variants = Object.entries(versions)
      .filter(([name]) => name !== '_original')
      .map(([name, version]) => ({
        name,
        url: version.url ?? '',
        mimeType: version.mime ?? '',
      }));
  };
  let historySeq = 0;

  function storeFor(uploadOptions: UploadOptions | undefined): ResumeStore {
    if (store) return store;
    if (
      uploadOptions?.resume?.strategy === 'memory' ||
      uploadOptions?.resume?.enabled === false
    ) {
      store = createMemoryResumeStore();
      return store;
    }
    store = createIndexedDbResumeStore();
    return store;
  }

  function upload(file: File, uploadOptions: UploadOptions = {}): UploadTask {
    const listeners: ListenerMap = { progress: new Set(), state: new Set() };
    const item: UploadHistoryItem = {
      localId: `upl_${(historySeq += 1)}`,
      filename: file.name,
      status: 'queued',
      bytesUploaded: 0,
      totalBytes: file.size,
      percentage: 0,
    };
    sinceLoad.push(item);
    let state: UploadState = 'queued';
    const control = { paused: false, cancelled: false };
    let currentAbort: AbortController | undefined;
    let session: SessionResponse | undefined;
    const setState = (next: UploadState) => {
      state = next;
      item.status = next;
      for (const listener of listeners.state) listener(next);
    };
    const task: UploadTask = {
      get state() {
        return state;
      },
      on(event, listener) {
        if (event === 'progress')
          listeners.progress.add(
            listener as (progress: UploadProgress) => void,
          );
        else listeners.state.add(listener as (state: UploadState) => void);
      },
      pause() {
        if (state === 'completed' || state === 'cancelled') return;
        control.paused = true;
        currentAbort?.abort();
        setState('paused');
      },
      resume() {
        if (!control.paused) return;
        control.paused = false;
        setState('uploading');
      },
      async cancel() {
        control.cancelled = true;
        control.paused = false;
        currentAbort?.abort();
        if (session) {
          await request(doFetch, `${endpoint}/sessions/${session.id}/abort`, {
            method: 'POST',
            headers: await headers(options.headers),
          }).catch(() => undefined);
        }
        if (uploadOptions.resume?.enabled !== false) {
          await storeFor(uploadOptions).delete(
            resumeKey(endpoint, fingerprint(file)),
          );
        }
        setState('cancelled');
      },
      complete: () => result,
    };

    const result = (async () => {
      await gate.acquire();
      try {
        setState('uploading');
        const record = await runUpload(file, uploadOptions, {
          endpoint,
          doFetch,
          headers: options.headers,
          partConcurrency,
          maxAttempts,
          baseDelayMs,
          control,
          setAbort: (controller) => {
            currentAbort = controller;
          },
          onProgress: (progress) => {
            item.bytesUploaded = progress.bytesUploaded;
            item.totalBytes = progress.totalBytes;
            item.percentage = progress.percentage;
            uploadOptions.onProgress?.(progress);
            for (const listener of listeners.progress) listener(progress);
          },
          onSession: (value) => {
            session = value;
          },
          store:
            uploadOptions.resume?.enabled === false
              ? undefined
              : storeFor(uploadOptions),
        });
        item.fileId = record.id;
        setState('completed');
        return record;
      } catch (error) {
        if (control.cancelled) {
          setState('cancelled');
          throw fail('CANCELLED');
        }
        setState('failed');
        throw error;
      } finally {
        gate.release();
      }
    })();
    return task;
  }

  async function waitForProcessing(
    fileId: string,
    wait: { timeoutMs?: number; intervalMs?: number } = {},
  ) {
    const timeoutMs = wait.timeoutMs ?? 30_000;
    const intervalMs = wait.intervalMs ?? 25;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      const response = await request(
        doFetch,
        `${endpoint}/files/${encodeURIComponent(fileId)}`,
        {
          headers: await headers(options.headers),
        },
      );
      if (response.processingState === 'failed') return response;
      const stillReceiving =
        response.processingState === 'none' &&
        (response.uploadState === 'uploading' ||
          response.uploadState === 'authorized');
      if (
        !stillReceiving &&
        (response.processingState === 'ready' ||
          response.processingState === 'none' ||
          response.processingState === 'partially_ready')
      ) {
        return response;
      }
      await delay(intervalMs);
    }
    throw fail('PROCESSING_TIMEOUT');
  }

  async function watchProcessing(
    fileId: string,
    listener: (update: ProcessingUpdate) => void,
    watch: {
      signal?: AbortSignal;
      channel?: 'sse' | 'poll';
      pollMs?: number;
    } = {},
  ): Promise<void> {
    const channel = watch.channel ?? progressChannel;
    const pollMs = watch.pollMs ?? progressPollMs;
    if (channel === 'sse') {
      try {
        await watchSse(fileId, listener, watch.signal);
        return;
      } catch (error) {
        if (watch.signal?.aborted) throw error;
      }
    }
    await watchPoll(fileId, listener, pollMs, watch.signal);
  }

  async function watchSse(
    fileId: string,
    listener: (update: ProcessingUpdate) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetchRaw(
      doFetch,
      `${endpoint}/files/${encodeURIComponent(fileId)}/progress`,
      { headers: await headers(options.headers), signal },
    );
    if (!response.ok) throw await errorFrom(response);
    await readEventStream(response, (update) => {
      listener(update);
      if (update.terminal) rememberVersions(fileId, update);
    });
  }

  async function watchPoll(
    fileId: string,
    listener: (update: ProcessingUpdate) => void,
    pollMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw fail('CANCELLED');
      const update = (await request(
        doFetch,
        `${endpoint}/files/${encodeURIComponent(fileId)}/progress`,
        {
          headers: {
            ...(await headers(options.headers)),
            accept: 'application/json',
          },
          signal,
        },
      )) as unknown as ProcessingUpdate;
      listener(update);
      if (update.terminal) {
        rememberVersions(fileId, update);
        return;
      }
      await delay(pollMs);
    }
  }

  async function history(): Promise<UploadHistory> {
    const completed: UploadHistoryItem[] = [];
    for (const item of sinceLoad) {
      if (item.status !== 'completed' || !item.fileId) continue;
      const delivery = (await request(
        doFetch,
        `${endpoint}/files/${encodeURIComponent(item.fileId)}/delivery`,
        {
          method: 'POST',
          headers: {
            ...(await headers(options.headers)),
            'content-type': 'application/json',
          },
          body: '{}',
        },
      )) as {
        original?: { url: string };
        variants?: Record<string, { url: string; mimeType: string }>;
      };
      item.originalUrl = delivery.original?.url;
      item.variants = Object.entries(delivery.variants ?? {}).map(
        ([name, variant]) => ({
          name,
          url: variant.url,
          mimeType: variant.mimeType,
        }),
      );
      completed.push({
        ...item,
        variants: item.variants?.map((variant) => ({ ...variant })),
      });
    }
    const inFlight = sinceLoad
      .filter(
        (item) =>
          item.status === 'queued' ||
          item.status === 'uploading' ||
          item.status === 'paused',
      )
      .map((item) => ({ ...item }));
    return {
      inFlight,
      sinceLoad: sinceLoad.map((item) => ({
        ...item,
        variants: item.variants?.map((variant) => ({ ...variant })),
      })),
      completed,
    };
  }

  async function transform(
    assetId: string,
    config: Record<string, unknown>,
    transformOptions: { webhook?: { url: string; secret?: string } } = {},
  ): Promise<{
    launched: true;
    jobId: string;
    assetId: string;
    sourceAssetId: string;
    replace: boolean;
  }> {
    return (await request(
      doFetch,
      `${endpoint}/files/${encodeURIComponent(assetId)}/transform`,
      {
        method: 'POST',
        headers: {
          ...(await headers(options.headers)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...config,
          ...(transformOptions.webhook
            ? { webhook: transformOptions.webhook }
            : {}),
        }),
      },
    )) as {
      launched: true;
      jobId: string;
      assetId: string;
      sourceAssetId: string;
      replace: boolean;
    };
  }

  async function fromUrl(
    url: string,
    importOptions: {
      webhook?: { url: string; secret?: string };
      preset?: string;
    } = {},
  ): Promise<{ assetId: string; id: string }> {
    const created = (await request(doFetch, `${endpoint}/assets/from-url`, {
      method: 'POST',
      headers: {
        ...(await headers(options.headers)),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url,
        ...(importOptions.preset ? { preset: importOptions.preset } : {}),
        ...(importOptions.webhook ? { webhook: importOptions.webhook } : {}),
      }),
    })) as { id?: string; asset?: { assetId?: string } };
    const assetId = created.asset?.assetId ?? created.id;
    if (!assetId) {
      throw fail('INVALID_CONFIG', {
        message: 'The remote import did not return an asset id.',
      });
    }
    return { assetId, id: created.id ?? assetId };
  }

  async function pending(): Promise<ResumeRecord[]> {
    const current = options.resumeStore ?? store;
    if (!current?.list) return [];
    const rows = await current.list();
    return rows.filter((row) => !row.endpoint || row.endpoint === endpoint);
  }

  async function uploadDirect(
    file: Blob & { name?: string },
    init: {
      filename?: string;
      mimeType: string;
      mode?: 'single' | 'multipart';
      onProgress?: (progress: UploadProgress) => void;
    },
  ) {
    const created = (await request(doFetch, `${endpoint}/uploads/direct`, {
      method: 'POST',
      headers: {
        ...(await headers(options.headers)),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        filename: init.filename ?? file.name ?? 'upload.bin',
        mimeType: init.mimeType,
        bytes: file.size,
        ...(init.mode ? { mode: init.mode } : {}),
      }),
    })) as {
      mode: 'single' | 'multipart';
      sessionId: string;
      fileId: string;
      url?: string;
      headers?: Record<string, string>;
      parts?: Array<{ partNumber: number; url: string }>;
      partSize?: number;
    };
    const report = (bytesUploaded: number) => {
      init.onProgress?.({
        bytesUploaded,
        totalBytes: file.size,
        percentage:
          file.size === 0 ? 100 : Math.round((bytesUploaded / file.size) * 100),
      });
    };
    report(0);
    if (created.mode === 'single') {
      if (!created.url) {
        throw fail('INVALID_CONFIG', {
          message: 'The direct upload has no URL.',
        });
      }
      const put = await doFetch(created.url, {
        method: 'PUT',
        headers: created.headers,
        body: file,
      });
      if (!put.ok) {
        throw fail('STORAGE_UNAVAILABLE', {
          message: `S3 rejected the upload (${put.status}).`,
        });
      }
      report(file.size);
      return request(
        doFetch,
        `${endpoint}/uploads/direct/${created.sessionId}/complete`,
        {
          method: 'POST',
          headers: {
            ...(await headers(options.headers)),
            'content-type': 'application/json',
          },
          body: '{}',
        },
      );
    }
    const partSize = created.partSize ?? file.size;
    const parts = created.parts ?? [];
    const completed: Array<{ partNumber: number; etag: string }> = [];
    let uploaded = 0;
    for (const part of parts) {
      const start = (part.partNumber - 1) * partSize;
      const chunk = file.slice(start, Math.min(file.size, start + partSize));
      const put = await doFetch(part.url, { method: 'PUT', body: chunk });
      if (!put.ok) {
        throw fail('STORAGE_UNAVAILABLE', {
          message: `S3 rejected part ${part.partNumber} (${put.status}).`,
        });
      }
      const etag = put.headers.get('etag');
      if (!etag) {
        throw fail('STORAGE_UNAVAILABLE', {
          message:
            'S3 did not return an ETag. Expose the ETag header in bucket CORS.',
        });
      }
      completed.push({ partNumber: part.partNumber, etag });
      uploaded += chunk.size;
      report(uploaded);
    }
    return request(
      doFetch,
      `${endpoint}/uploads/direct/${created.sessionId}/complete`,
      {
        method: 'POST',
        headers: {
          ...(await headers(options.headers)),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ parts: completed }),
      },
    );
  }

  return {
    endpoint,
    upload,
    uploadDirect,
    fromUrl,
    transform,
    waitForProcessing,
    watchProcessing,
    history,
    pending,
  };
}

interface RunContext {
  endpoint: string;
  doFetch: typeof fetch;
  headers: UploadClientOptions['headers'];
  partConcurrency: number;
  maxAttempts: number;
  baseDelayMs: number;
  control: { paused: boolean; cancelled: boolean };
  setAbort: (controller: AbortController | undefined) => void;
  onProgress: (progress: UploadProgress) => void;
  onSession: (session: SessionResponse) => void;
  store: ResumeStore | undefined;
}

async function runUpload(
  file: File,
  uploadOptions: UploadOptions,
  ctx: RunContext,
): Promise<UploadedFile> {
  const key = resumeKey(ctx.endpoint, fingerprint(file));
  const existing = ctx.store ? await ctx.store.get(key) : undefined;
  let session = existing
    ? await reloadSession(existing, file, uploadOptions, ctx)
    : undefined;
  if (!session)
    session = await createSession(
      file,
      uploadOptions,
      ctx,
      existing?.idempotencyKey,
    );
  ctx.onSession(session);
  if (session.status === 'verified') return readFile(ctx, session.fileId);
  const pending = missingParts(session);
  const etags: Array<{ partNumber: number; etag: string }> = [];
  let uploadedBytes = uploadedByteCount(session, file.size);
  ctx.onProgress(progress(uploadedBytes, file.size));
  let cursor = 0;
  const workerCount = Math.min(
    ctx.partConcurrency,
    Math.max(pending.length, 1),
  );
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: pending.length === 0 ? 0 : workerCount }, async () => {
      while (failures.length === 0) {
        const partNumber = pending[cursor];
        cursor += 1;
        if (partNumber === undefined) return;
        await waitIfPaused(ctx);
        const etag = await sendPart(
          file,
          session as SessionResponse,
          partNumber,
          ctx,
        );
        etags.push({ partNumber, etag });
        uploadedBytes += partBytes(
          file.size,
          (session as SessionResponse).partSize,
          partNumber,
          (session as SessionResponse).partCount,
        );
        (session as SessionResponse).uploadedParts.push(partNumber);
        if (ctx.store)
          await ctx.store.set(
            key,
            persistable(
              session as SessionResponse,
              file,
              uploadOptions,
              ctx.endpoint,
            ),
          );
        ctx.onProgress(progress(Math.min(uploadedBytes, file.size), file.size));
      }
    }),
  ).catch((error) => {
    failures.push(error);
  });
  const failure = failures[0];
  if (failure) throw failure;
  const completed = await request(ctx.doFetch, session.completeUrl, {
    method: 'POST',
    headers: {
      ...(await headers(ctx.headers)),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ checksum: uploadOptions.checksum, parts: etags }),
  });
  const fileRecord = (completed.file ?? completed) as UploadedFile;
  if (ctx.store) await ctx.store.delete(key);
  return fileRecord;
}

async function reloadSession(
  existing: ResumeRecord,
  file: File,
  uploadOptions: UploadOptions,
  ctx: RunContext,
): Promise<SessionResponse | undefined> {
  const response = await fetchRaw(
    ctx.doFetch,
    `${ctx.endpoint}/sessions/${existing.sessionId}`,
    {
      headers: await headers(ctx.headers),
    },
  );
  if (response.status === 404 || response.status === 410) {
    if (ctx.store)
      await ctx.store.delete(resumeKey(ctx.endpoint, fingerprint(file)));
    throw await errorFrom(response);
  }
  if (!response.ok) throw await errorFrom(response);
  const session = (await response.json()) as SessionResponse;
  if (
    session.status === 'expired' ||
    Date.parse(session.expiresAt) <= Date.now()
  ) {
    throw fail('UPLOAD_SESSION_EXPIRED');
  }
  session.partUrlTemplate = existing.partUrlTemplate;
  session.completeUrl = existing.completeUrl;
  session.idempotencyKey = existing.idempotencyKey;
  session.uploadedParts = session.receivedParts.map((part) => part.partNumber);
  void uploadOptions;
  return session;
}

async function createSession(
  file: File,
  uploadOptions: UploadOptions,
  ctx: RunContext,
  previousKey: string | undefined,
): Promise<SessionResponse> {
  const idempotencyKey = previousKey ?? `idem_${fingerprint(file)}`;
  const created = (await request(ctx.doFetch, `${ctx.endpoint}/sessions`, {
    method: 'POST',
    headers: {
      ...(await headers(ctx.headers)),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      bytes: file.size,
      idempotencyKey,
      ...(uploadOptions.preset ? { preset: uploadOptions.preset } : {}),
      ...(uploadOptions.metadata ? { metadata: uploadOptions.metadata } : {}),
      ...(uploadOptions.checksum ? { checksum: uploadOptions.checksum } : {}),
      ...(uploadOptions.webhook ? { webhook: uploadOptions.webhook } : {}),
    }),
  })) as unknown as SessionResponse;
  created.idempotencyKey = idempotencyKey;
  created.uploadedParts =
    created.receivedParts?.map((part) => part.partNumber) ?? [];
  if (ctx.store)
    await ctx.store.set(
      resumeKey(ctx.endpoint, fingerprint(file)),
      persistable(created, file, uploadOptions, ctx.endpoint),
    );
  return created;
}

async function sendPart(
  file: File,
  session: SessionResponse,
  partNumber: number,
  ctx: RunContext,
): Promise<string> {
  const start = (partNumber - 1) * session.partSize;
  const end = Math.min(start + session.partSize, file.size);
  const chunk = file.slice(start, end);
  const url =
    session.partUrls?.[String(partNumber)] ??
    session.partUrlTemplate.replace('{partNumber}', String(partNumber));
  let attempt = 0;
  while (attempt < ctx.maxAttempts) {
    await waitIfPaused(ctx);
    const controller = new AbortController();
    ctx.setAbort(controller);
    try {
      const response = await fetchRaw(ctx.doFetch, url, {
        method: 'PUT',
        headers: await headers(ctx.headers),
        body: chunk,
        signal: controller.signal,
      });
      if (!response.ok) throw await errorFrom(response);
      let etag = response.headers.get('etag') ?? '';
      if (!etag) {
        const body = (await response.json().catch(() => ({}))) as {
          etag?: string;
        };
        etag = body.etag ?? '';
      }
      if (!etag) throw fail('UPLOAD_PART_MISSING');
      ctx.setAbort(undefined);
      return etag;
    } catch (error) {
      ctx.setAbort(undefined);
      if (ctx.control.cancelled) throw fail('CANCELLED');
      if (
        ctx.control.paused ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        await waitIfPaused(ctx);
        continue;
      }
      if (error instanceof FileSdkError && !error.retryable) throw error;
      attempt += 1;
      if (attempt >= ctx.maxAttempts) throw error;
      await delay(ctx.baseDelayMs * attempt);
    }
  }
  throw fail('UPLOAD_PART_MISSING');
}

async function readFile(
  ctx: RunContext,
  fileId: string,
): Promise<UploadedFile> {
  return request(
    ctx.doFetch,
    `${ctx.endpoint}/files/${encodeURIComponent(fileId)}`,
    {
      headers: await headers(ctx.headers),
    },
  ) as unknown as Promise<UploadedFile>;
}

function persistable(
  session: SessionResponse,
  file: File,
  uploadOptions: UploadOptions,
  endpoint: string,
): ResumeRecord {
  const mode = uploadOptions.resume?.persistBlob ?? 'auto';
  const maxBytes = uploadOptions.resume?.maxPersistedBytes ?? 32 * 1024 * 1024;
  const keepBlob =
    mode === 'always' || (mode === 'auto' && file.size <= maxBytes);
  return {
    fingerprint: fingerprint(file),
    endpoint,
    filename: file.name,
    sessionId: session.id ?? session.sessionId,
    fileId: session.fileId,
    idempotencyKey: session.idempotencyKey,
    partSize: session.partSize,
    partCount: session.partCount,
    uploadedParts: [...(session.uploadedParts ?? [])],
    partUrlTemplate: session.partUrlTemplate,
    completeUrl: session.completeUrl,
    expiresAt: session.expiresAt,
    ...(keepBlob ? { blob: file } : {}),
  };
}

function missingParts(session: SessionResponse): number[] {
  const have = new Set(
    session.uploadedParts ??
      session.receivedParts?.map((part) => part.partNumber) ??
      [],
  );
  const parts: number[] = [];
  for (let part = 1; part <= session.partCount; part += 1)
    if (!have.has(part)) parts.push(part);
  return parts;
}

function uploadedByteCount(session: SessionResponse, total: number): number {
  return (session.uploadedParts ?? []).reduce(
    (sum, part) =>
      sum + partBytes(total, session.partSize, part, session.partCount),
    0,
  );
}

function partBytes(
  total: number,
  partSize: number,
  partNumber: number,
  partCount: number,
): number {
  if (partNumber === partCount) return total - partSize * (partCount - 1);
  return partSize;
}

function progress(bytesUploaded: number, totalBytes: number): UploadProgress {
  return {
    bytesUploaded,
    totalBytes,
    percentage:
      totalBytes === 0 ? 0 : Math.round((bytesUploaded / totalBytes) * 100),
  };
}

function fingerprint(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

async function waitIfPaused(ctx: RunContext): Promise<void> {
  while (ctx.control.paused && !ctx.control.cancelled) await delay(15);
  if (ctx.control.cancelled) throw fail('CANCELLED');
}

async function headers(
  source: UploadClientOptions['headers'],
): Promise<Record<string, string>> {
  const resolved = typeof source === 'function' ? await source() : source;
  const output: Record<string, string> = {};
  new Headers(resolved).forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

async function request(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await fetchRaw(doFetch, url, init);
  if (!response.ok) throw await errorFrom(response);
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

async function fetchRaw(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    throw fail('STORAGE_UNAVAILABLE', {
      message:
        error instanceof Error ? error.message : 'The upload request failed.',
    });
  }
}

async function errorFrom(response: Response): Promise<FileSdkError> {
  let body: { code?: string; message?: string };
  try {
    body = (await response.json()) as { code?: string; message?: string };
  } catch {
    body = {};
  }
  const code =
    body.code && ERROR_CODES.includes(body.code as ErrorCode)
      ? (body.code as ErrorCode)
      : 'INVALID_CONFIG';
  return fail(code, { message: body.message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGate(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire() {
      if (active >= max)
        await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
    },
    release() {
      active -= 1;
      waiting.shift()?.();
    },
  };
}

export type UploadClient = ReturnType<typeof createUploadClient>;
