import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFilesHandler, handleNodeRequest } from '../http/index.js';

type FilesHandler = ReturnType<typeof createFilesHandler>;

interface FastifyLike {
  all(
    path: string,
    handler: (
      request: { raw: IncomingMessage },
      reply: { raw: ServerResponse; hijack: () => void },
    ) => Promise<void>,
  ): void;
}

/** Fastify plugin. Call `reply.hijack()` so Fastify does not write a second body. */
export function fastifyPlugin(handler: FilesHandler) {
  return async function filevoraPlugin(app: FastifyLike) {
    app.all('/*', async (request, reply) => {
      reply.hijack();
      await handleNodeRequest(handler, request.raw, reply.raw);
    });
  };
}
