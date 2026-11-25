# Semantic search

`POST /files/search` finds assets by meaning. Send a natural-language prompt in any language and get a paginated list of matching assets, each with a similarity `score`. It needs stored mode and `FILEVORA_GEMINI_API_KEY`. No new service is required: vectors live in your host database and the ranking runs in your Node process.

## How it works

1. When a Gemini description finishes, Filevora builds one canonical text from the asset type, MIME type, short and long description, and tags. It embeds that text with `gemini-embedding-001` at 768 dimensions (`RETRIEVAL_DOCUMENT`, with the file name as title) and stores a unit-length float32 vector in `filevora_asset_embeddings`.
2. A search embeds the prompt once (`RETRIEVAL_QUERY`), applies every structured filter in SQL, reads the remaining vectors in keyset chunks, and keeps only the best page in memory. Similarity is the cosine, which for unit vectors is the dot product.
3. Results are ordered by `score` descending, then asset id descending, so ties never reorder between pages.

The description text is the only thing embedded. The asset bytes are not sent to the embedding model. A search sends the prompt to Google.

## Request

```http
POST /files/search
content-type: application/json

{ "query": "animali che giocano", "type": "image", "createdFrom": "2026-10-01", "minScore": 0.55, "maxResults": 100, "limit": 20 }
```

`query` is required, 1 to 2000 characters after trimming. The structured filters are the ones `GET /files` accepts (`type`, dates, `tags`, `tagsAll`, `tagCategory`, `mime`, `filename`, sizes, dimensions, duration, `status`, `visibility`, `preset`). `q`, `sort`, and `order` do not apply; ordering is always by score.

## Result selection

| Field | Meaning | Default | Range |
| --- | --- | --- | --- |
| `minScore` | Minimum cosine similarity. Equivalent to a maximum vector distance of `1 - minScore`. | `FILEVORA_SEARCH_MIN_SCORE`, 0.55 | 0 to 1 |
| `maxResults` | Hard cap on results across all pages. | `FILEVORA_SEARCH_MAX_RESULTS`, 100 | 1 to 1000 |
| `limit` | Page size. Clamped to what is left under `maxResults`. | 20 | 1 to 100 |
| `cursor` | `nextCursor` of the previous page. | none | |

Every field can be set per request. The environment values only provide the defaults.

The response:

```json
{
  "items": [{ "score": 0.683214, "file": { "id": "file_...", "description": { "short": "..." } } }],
  "nextCursor": "eyJ2IjoxLC4uLn0",
  "meta": { "model": "gemini-embedding-001", "dimensions": 768, "minScore": 0.55, "maxResults": 100, "candidatesScored": 4210, "capped": false }
}
```

`score` is rounded to six decimals. `nextCursor` is `null` on the last page. `meta.capped` is true when more matches exist than `maxResults` allowed, so the list was cut. Raise `maxResults`, raise `minScore`, or add filters.

Keep `query`, `minScore`, `maxResults`, model, and every filter unchanged when you send `nextCursor` back. A cursor from a different search returns `SEARCH_QUERY_INVALID`. Later pages reuse the cached query vector, so they do not call Gemini again.

### The 0.55 default is not calibrated

`0.55` is a planning estimate, not a measurement. It has not been validated against real Gemini output on real descriptions, and no such run exists in this repository. Embedding models give unrelated texts a high baseline cosine, so a sensible threshold is well above zero but its exact value depends on your descriptions. Calibrate it before relying on it (run `pnpm build` first):

1. Describe a representative sample of your assets.
2. Run `FILEVORA_CALIBRATION_GEMINI_KEY=... node --experimental-strip-types --test test/search-calibration.test.ts` from `packages/filevora`. It prints precision and recall for `minScore` 0.45 to 0.70 over `test/fixtures/search-calibration.json`.
3. Replace the fixture descriptions and queries with ones from your own library, then set `FILEVORA_SEARCH_MIN_SCORE`.

The fixture in this repository is hand-written. The offline run uses a mock embedding model and only proves the harness works.

## Indexing lifecycle

- Embedding runs at the end of the description job, after the description is stored. A failed embedding does not fail the description or the asset. The asset is left out of search until the next successful describe.
- `POST /files/:id/describe` runs the description again and replaces the embedding, including for a ready image or video.
- Deleting an asset removes its vector. Retention that deletes bytes removes it too.
- Changing `FILEVORA_EMBEDDING_MODEL` or `FILEVORA_EMBEDDING_DIMENSIONS` does not rewrite old vectors. Search only reads vectors of the current model and dimension, so run `describe` again for the assets you want searchable under the new setting. There is no bulk reindex.

## Scale

Search is exact, not approximate. Every vector that passes the SQL filters is scored on each new query. Time grows linearly with the number of filtered embedded assets and each vector is 3 KB at 768 dimensions. Use filters to narrow big libraries. The scan streams 5000 rows at a time, so memory stays bounded.

## Configuration

| Variable | Default |
| --- | --- |
| `FILEVORA_EMBEDDING_MODEL` | `gemini-embedding-001` |
| `FILEVORA_EMBEDDING_DIMENSIONS` | `768` (128 to 3072) |
| `FILEVORA_SEARCH_MIN_SCORE` | `0.55` |
| `FILEVORA_SEARCH_MAX_RESULTS` | `100` |

The Gemini key is `FILEVORA_GEMINI_API_KEY`. `gemini.embeddingModel`, `gemini.embeddingDimensions`, `gemini.searchMinScore`, and `gemini.searchMaxResults` are the matching `createFiles` options.

## Errors

| Code | Status | Meaning |
| --- | --- | --- |
| `DESCRIPTION_REQUIRES_DATABASE` | 422 | Lite mode. Set `FILEVORA_DATABASE_URL`. |
| `DESCRIPTION_NOT_CONFIGURED` | 422 | No `FILEVORA_GEMINI_API_KEY`. |
| `SEARCH_QUERY_INVALID` | 400 | Bad query, filter, range, or cursor. |
| `EMBEDDING_UNAVAILABLE` | 503 | The embedding call failed. Retry with backoff. |

## SDK and MCP

`createUploadClient().search('animali che giocano')` or `.search({ query, minScore, maxResults, limit, cursor })`. The `filevora mcp` tool `search_assets` runs the search live against `FILEVORA_DATABASE_URL` and `FILEVORA_GEMINI_API_KEY` from the MCP process environment (or its `env` argument). It requires `tenantId`, because the MCP process has no signed-in user.
