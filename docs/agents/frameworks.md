# Framework helpers

No UI components. Copy-paste examples are in [docs/frameworks.md](../frameworks.md).

- `filevora/next`: `createNextHandlers` for App Router route files, `uploadFormFile` for a server action body. The app file adds `'use server'`.
- `filevora/express`: `expressMiddleware(handler)`.
- `filevora/fastify`: `fastifyPlugin(handler)` calls `reply.hijack()`.
- `filevora/hono`: `honoHandler(handler)`.
- `filevora/client`: `upload` (progress events), `waitForProcessing`, `uploadDirect`, `fetchSigned`. This entry does not import Node builtins.
- `filevora/react`: `useUpload`, `useAssetProgress`. Optional peer `react`. The hooks return state only.
