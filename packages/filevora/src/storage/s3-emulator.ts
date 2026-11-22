import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

interface Part {
  etag: string;
  body: Buffer;
}

interface Upload {
  parts: Map<number, Part>;
}

/**
 * Path-style S3 subset for tests. It stores parts and does not require Docker.
 * It rejects a request whose URL contains the raw secret. It does not validate SigV4.
 */
export async function startS3Emulator(options: {
  bucket: string;
  secret: string;
}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Upload>();
  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      if (
        url.search.includes(options.secret) ||
        (req.url ?? '').includes(options.secret)
      ) {
        res.writeHead(403);
        res.end('secret leaked');
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors());
        res.end();
        return;
      }
      const key = decodeURIComponent(
        url.pathname.replace(new RegExp(`^/${options.bucket}/`), ''),
      );
      if (req.method === 'POST' && url.searchParams.has('uploads')) {
        const uploadId = randomBytes(8).toString('hex');
        uploads.set(uploadId, { parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml', ...cors() });
        res.end(
          `<InitiateMultipartUploadResult><Bucket>${options.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        );
        return;
      }
      const uploadId = url.searchParams.get('uploadId');
      if (req.method === 'PUT' && !uploadId) {
        const body = await readBody(req);
        objects.set(key, body);
        res.writeHead(200, {
          etag: `"${createHash('md5').update(body).digest('hex')}"`,
          ...cors(),
        });
        res.end();
        return;
      }
      if (
        req.method === 'PUT' &&
        uploadId &&
        url.searchParams.get('partNumber')
      ) {
        const body = await readBody(req);
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        const upload = uploads.get(uploadId);
        if (!upload) {
          res.writeHead(404);
          res.end();
          return;
        }
        upload.parts.set(Number(url.searchParams.get('partNumber')), {
          etag,
          body,
        });
        res.writeHead(200, { etag, ...cors() });
        res.end();
        return;
      }
      if (req.method === 'POST' && uploadId) {
        const upload = uploads.get(uploadId);
        const xml = (await readBody(req)).toString();
        if (!upload) {
          res.writeHead(404);
          res.end();
          return;
        }
        const numbers = [
          ...xml.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g),
        ].map((match) => Number(match[1]));
        const chunks = numbers
          .sort((a, b) => a - b)
          .map((number) => upload.parts.get(number)?.body);
        if (chunks.some((chunk) => !chunk)) {
          res.writeHead(400);
          res.end('missing part');
          return;
        }
        objects.set(key, Buffer.concat(chunks as Buffer[]));
        uploads.delete(uploadId);
        res.writeHead(200, { 'content-type': 'application/xml', ...cors() });
        res.end(
          `<CompleteMultipartUploadResult><Bucket>${options.bucket}</Bucket><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
        );
        return;
      }
      if (req.method === 'GET') {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-length': object.byteLength,
          'content-type': 'application/octet-stream',
          ...cors(),
        });
        res.end(object);
        return;
      }
      if (req.method === 'HEAD') {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-length': object.byteLength, ...cors() });
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204, cors());
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function cors(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,PUT,POST,DELETE,HEAD,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers': 'ETag',
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
