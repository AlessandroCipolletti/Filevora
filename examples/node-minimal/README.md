# Node example

Minimal Node HTTP server. It uses filesystem storage and SQLite. There is no Filevora account.

```bash
FILES_ENV=test node --experimental-strip-types examples/node-minimal/server.ts
```

Send `x-user` and `x-tenant` headers. The process prints `listening <port>`. Routes are under `/api/files`.
