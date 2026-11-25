# Semantic search for agents

Use `POST /files/search` with a natural-language `query` when the user describes what an asset shows or says. Use `GET /files` for exact tags, dates, names, or `q` keywords. Do not invent a `GET` search and do not call `/search/reindex`; there is none.

Requires stored mode (`FILEVORA_DATABASE_URL`) and `FILEVORA_GEMINI_API_KEY`. Lite mode returns `DESCRIPTION_REQUIRES_DATABASE` (422). A missing key returns `DESCRIPTION_NOT_CONFIGURED` (422). Do not retry either unchanged. `EMBEDDING_UNAVAILABLE` (503) follows its `retryable` flag: true for 429, 5xx, and timeouts (retry with backoff), false when Google answered 400, 401, 402, or 403 (key, billing, or permission; read `context.geminiMessage` and do not retry unchanged). `SEARCH_QUERY_INVALID` (400) is a bad input; read the message.

Body: `query` (required, 1 to 2000 characters, any language), the `GET /files` structured filters (`type`, `createdFrom`, `createdTo`, `tags`, `tagsAll`, `mime`, `visibility`, and the rest), `minScore`, `maxResults`, `limit`, `cursor`.

- `minScore` (0 to 1, default 0.55, uncalibrated) is the minimum cosine similarity, the same as a maximum distance of `1 - minScore`. Lower it for more recall, raise it for precision.
- `maxResults` (1 to 1000, default 100) caps the total across all pages. `limit` (1 to 100, default 20) is the page size.
- Every item has `score` and `file`. Items are sorted by `score` descending.
- Read `nextCursor`. When it is not null, send it back as `cursor` with the same `query`, `minScore`, `maxResults`, and filters. Anything else is `SEARCH_QUERY_INVALID`.
- If `meta.capped` is true there were more matches than `maxResults`. Narrow with filters or raise `minScore` or `maxResults`.
- An asset appears only after its description has finished and been embedded. A recently uploaded asset may be missing. After a model or dimension change, run `POST /files/:id/describe` again.

SDK: `client.search('animali che giocano')` or `client.search({ query, type: 'image', minScore: 0.6 })`.

MCP: `search_assets` with `tenantId` and `query`. It runs live and needs `FILEVORA_DATABASE_URL` and `FILEVORA_GEMINI_API_KEY` in the MCP process environment. More in [docs/search.md](../search.md).
