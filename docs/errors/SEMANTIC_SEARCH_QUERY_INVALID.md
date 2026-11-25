# SEMANTIC_SEARCH_QUERY_INVALID

A `POST /files/semantic-search` field is invalid. The message names the field and the constraint it breaks.

Category: `config`. HTTP 400. Retryable: false.

- `query` is required and is 1 to 2000 characters after trimming.
- `minScore` is a number from 0 to 1 (minimum cosine similarity).
- `maxResults` is an integer from 1 to 1000 (hard cap across all pages).
- `limit` is an integer from 1 to 100.
- Filters (`type`, `createdFrom`, `tags`, `mime`, `status`, and the rest) follow the same rules as `GET /files`.
- `cursor` must come from the previous page of the same search. Keep `query`, `minScore`, `maxResults`, and every filter unchanged when you pass `nextCursor`, or omit `cursor` to start from the first page.

- fix_semantic_search_query: Read the field named in the error and send a value inside the listed range.

See [semantic search](../search.md).
