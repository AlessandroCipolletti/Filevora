import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFilesHandler, handleNodeRequest } from '../http/index.js';

type FilesHandler = ReturnType<typeof createFilesHandler>;

/** Express middleware. The handler is the same one `createFilesHandler` returns. */
export function expressMiddleware(handler: FilesHandler) {
  return (
    req: IncomingMessage,
    res: ServerResponse,
    next?: (error: unknown) => void,
  ) => {
    handleNodeRequest(handler, req, res).catch((error: unknown) => {
      if (next) next(error);
      else if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  };
}
