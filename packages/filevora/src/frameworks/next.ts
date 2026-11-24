import { createFilesHandler, type FilesHandlerOptions } from '../http/index.js';
import type { Files, RequestContext } from '../server/index.js';

type NextHandler = (request: Request) => Promise<Response> | Response;

/** App Router handlers. Mount them from `app/api/files/[[...path]]/route.ts`. */
export function createNextHandlers(
  options: FilesHandlerOptions,
): Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', NextHandler> {
  const handle = createFilesHandler(options);
  const route: NextHandler = (request) => handle(request);
  return { GET: route, POST: route, PUT: route, PATCH: route, DELETE: route };
}

/**
 * Body of a server action. The app file adds `'use server'` and passes the
 * signed-in principal. This helper does not render UI.
 */
export async function uploadFormFile(
  files: Files,
  form: FormData,
  ctx: RequestContext,
) {
  const entry = form.get('file');
  if (!(entry instanceof Blob)) {
    throw new Error('The form field "file" must be a file.');
  }
  const filename = entry instanceof File ? entry.name : 'upload.bin';
  const bytes = new Uint8Array(await entry.arrayBuffer());
  const session = await files.createUploadSession(
    {
      filename,
      mimeType: entry.type || 'application/octet-stream',
      bytes: bytes.byteLength,
    },
    ctx,
  );
  for (let part = 1; part <= session.partCount; part += 1) {
    const start = (part - 1) * session.partSize;
    const end = Math.min(start + session.partSize, bytes.byteLength);
    await files.writePart(session.id, part, bytes.subarray(start, end), ctx);
  }
  return files.completeUpload(session.id, {}, ctx);
}
