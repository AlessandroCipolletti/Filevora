import http from 'node:http';
import https from 'node:https';
import { fail, isFileSdkError } from '../errors/error.js';
import { sniffMime } from '../mime.js';
import { checkRemoteUrl, type RemotePolicy } from './policy.js';

export interface RemoteDownload {
  mime: string;
  bytes: AsyncIterable<Uint8Array>;
}

/**
 * Download a remote file without buffering it. The first bytes are sniffed
 * before the rest of the body is yielded. Each redirect is checked again,
 * and the socket connects to the address that passed that check.
 */
export async function downloadRemote(input: {
  url: string;
  policy: RemotePolicy;
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
}): Promise<RemoteDownload> {
  const signal = input.signal ?? AbortSignal.timeout(input.policy.timeoutMs);
  const response = await follow(input.url, input.policy, signal, 0);
  const total = contentLength(response);
  const iterator = streamChunks(response);
  const prefix: Uint8Array[] = [];
  let received = 0;
  try {
    while (received < 64) {
      const next = await iterator.next();
      if (next.done) break;
      received += next.value.byteLength;
      assertSize(received, input.policy.maxBytes);
      prefix.push(next.value);
      input.onProgress?.(received, total);
    }
  } catch (error) {
    response.destroy();
    throw error;
  }
  const sample = concat(prefix).subarray(0, 64);
  const mime = sniffMime(sample);
  if (!mime) {
    response.destroy();
    throw fail('UNSUPPORTED_MIME', {
      message: 'The remote file did not match an allowed type.',
    });
  }
  return {
    mime,
    bytes: remaining(prefix, iterator, received, total, input, response),
  };
}

async function follow(
  raw: string,
  policy: RemotePolicy,
  signal: AbortSignal,
  redirects: number,
): Promise<http.IncomingMessage> {
  if (signal.aborted) throw timeout();
  const checked = await checkRemoteUrl(
    raw,
    policy,
    redirects === 0 ? 'request' : 'redirect',
  );
  const response = await requestOnce(
    checked.url,
    checked.address,
    policy,
    signal,
  );
  const status = response.statusCode ?? 0;
  if (status >= 300 && status < 400) {
    const location = response.headers.location;
    response.resume();
    if (!location) {
      throw fail('REMOTE_URL_REDIRECT', {
        message: 'The remote server redirected without a location.',
      });
    }
    if (redirects >= policy.maxRedirects) {
      throw fail('REMOTE_URL_REDIRECT', {
        message: 'The remote URL redirected too many times.',
        context: { maxRedirects: policy.maxRedirects },
      });
    }
    const next = new URL(location, checked.url).toString();
    return follow(next, policy, signal, redirects + 1);
  }
  if (status !== 200) {
    response.resume();
    throw fail('REMOTE_URL_BLOCKED', {
      message: 'The remote server did not return the file.',
      context: { status },
    });
  }
  return response;
}

function requestOnce(
  target: URL,
  address: string,
  policy: RemotePolicy,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  const lib = target.protocol === 'https:' ? https : http;
  const family = address.includes(':') ? 6 : 4;
  return new Promise((resolve, reject) => {
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const req = lib.request(
      target,
      {
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'filevora' },
        lookup: (_hostname, _options, callback) => {
          callback(null, address, family);
        },
        signal,
      },
      (response) => {
        clearTimeout(timer.id);
        resolve(response);
      },
    );
    timer.id = setTimeout(() => {
      req.destroy();
      reject(timeout());
    }, policy.connectTimeoutMs);
    req.on('socket', (socket) => {
      if (socket.connecting) {
        socket.once('connect', () => clearTimeout(timer.id));
      } else {
        clearTimeout(timer.id);
      }
    });
    req.on('error', (error) => {
      clearTimeout(timer.id);
      if (signal.aborted || isFileSdkError(error)) {
        reject(signal.aborted ? timeout() : error);
        return;
      }
      reject(
        fail('REMOTE_URL_BLOCKED', {
          message: 'The remote connection failed.',
          context: { host: target.hostname },
        }),
      );
    });
    req.end();
  });
}

async function* remaining(
  prefix: Uint8Array[],
  iterator: AsyncIterator<Uint8Array>,
  received: number,
  total: number | null,
  input: {
    policy: RemotePolicy;
    onProgress?: (received: number, total: number | null) => void;
  },
  response: http.IncomingMessage,
): AsyncGenerator<Uint8Array> {
  try {
    for (const chunk of prefix) yield chunk;
    while (true) {
      const next = await iterator.next();
      if (next.done) return;
      received += next.value.byteLength;
      assertSize(received, input.policy.maxBytes);
      input.onProgress?.(received, total);
      yield next.value;
    }
  } finally {
    response.destroy();
  }
}

function streamChunks(
  response: http.IncomingMessage,
): AsyncIterator<Uint8Array> {
  return (async function* chunks() {
    for await (const chunk of response) {
      yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    }
  })();
}

function contentLength(response: http.IncomingMessage): number | null {
  const header = response.headers['content-length'];
  if (typeof header !== 'string' || !/^\d+$/.test(header)) return null;
  return Number(header);
}

function assertSize(received: number, maxBytes: number): void {
  if (received > maxBytes) {
    throw fail('FILE_TOO_LARGE', {
      message: 'The remote file is larger than the configured limit.',
      context: { maxBytes },
    });
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function timeout() {
  return fail('REMOTE_URL_TIMEOUT', {
    message: 'The remote download timed out.',
  });
}
