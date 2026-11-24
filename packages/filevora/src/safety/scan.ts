import { createConnection } from 'node:net';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { fail } from '../errors/error.js';

export interface MalwareScanInput {
  assetId: string;
  mime: string;
  /** Filesystem path of the stored original, when the bytes are on disk. */
  path?: string;
  bytes?: Uint8Array;
}

/** Plug in any scanner. `infected` rejects the asset. A throw is a failed scan. */
export interface MalwareScanner {
  scan(input: MalwareScanInput): Promise<'clean' | 'infected'>;
}

/**
 * ClamAV `INSTREAM` over TCP. The response `stream: OK` is clean.
 * Any `FOUND` reply is infected. Anything else, including a dead socket, throws.
 */
export function createClamAvScanner(options: {
  host: string;
  port: number;
  timeoutMs?: number;
}): MalwareScanner {
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    async scan(input) {
      const source = input.bytes
        ? Readable.from([Buffer.from(input.bytes)])
        : input.path
          ? createReadStream(input.path)
          : null;
      if (!source) {
        throw fail('MALWARE_SCAN_FAILED', {
          message: 'The malware scanner had no bytes to read.',
        });
      }
      const reply = await instream(
        options.host,
        options.port,
        timeoutMs,
        source,
      );
      if (reply.includes('FOUND')) return 'infected';
      if (reply.includes('OK')) return 'clean';
      throw fail('MALWARE_SCAN_FAILED', {
        message: 'ClamAV did not return a clean or infected result.',
      });
    },
  };
}

function instream(
  host: string,
  port: number,
  timeoutMs: number,
  source: Readable,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        fail('MALWARE_SCAN_FAILED', {
          message: 'The malware scanner timed out.',
        }),
      );
    }, timeoutMs);
    let reply = '';
    const failScan = (error: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      reject(
        error instanceof Error && error.name === 'FileSdkError'
          ? error
          : fail('MALWARE_SCAN_FAILED', {
              message: 'The malware scanner connection failed.',
            }),
      );
    };
    socket.on('error', failScan);
    socket.on('data', (chunk) => {
      reply += chunk.toString();
    });
    socket.on('connect', () => {
      socket.write(Buffer.from('zINSTREAM\0'));
      source.on('data', (chunk: Buffer) => {
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.byteLength);
        socket.write(size);
        socket.write(chunk);
      });
      source.on('end', () => {
        const end = Buffer.alloc(4);
        end.writeUInt32BE(0);
        socket.write(end);
      });
      source.on('error', failScan);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}
