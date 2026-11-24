import { createFilesHandler } from '../http/index.js';

type FilesHandler = ReturnType<typeof createFilesHandler>;

interface HonoContext {
  req: { raw: Request };
}

/** Hono handler. `app.all('/*', honoHandler(handler))`. */
export function honoHandler(handler: FilesHandler) {
  return (context: HonoContext) => handler(context.req.raw);
}
