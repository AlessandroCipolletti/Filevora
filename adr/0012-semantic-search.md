# ADR 0012: Semantic search

## Status

Accepted. Supersedes the earlier decision to leave `semanticSearch` unsupported.

## Problem

Agents need to find assets by meaning ("animali che giocano") across languages, with pagination and without running a vector database.

## Constraints

Stored mode only, because descriptions already live in the host database. No new infrastructure. No silent upload of private bytes: only the description text and the search prompt go to Google. No backfill, reindex job, or backward compatibility.

## Options

1. A vector extension or service (pgvector, Qdrant, Redis vectors).
2. Vectors as binary columns in the host database, ranked exactly in Node.

## Decision

Option 2. `gemini-embedding-2` at 768 dimensions (a multimodal model that embeds a file rendition together with its description, and text queries into the same space), L2-normalized client side, stored as little-endian float32 in `filevora_asset_embeddings` (BYTEA on PostgreSQL, BLOB on SQLite and MySQL). `POST /files/semantic-search` applies the structured filters in SQL, streams vectors in keyset chunks, and keeps a bounded heap of the best `limit + 1` hits. Pages are ordered by quantized score then asset id. The cursor carries a fingerprint of the query, so a changed query is rejected. `minScore` defaults to 0.65, a provisional value from one live run of the text fixture with `gemini-embedding-2` (precision 0.77, recall 0.82), to be confirmed by a run on real files. `maxResults` bounds a search across pages.

## Rejected alternatives

pgvector and similar: portable across PostgreSQL, MySQL, and SQLite matters more than ANN speed at the library sizes this package targets. Approximate indexes also make cursors unstable. A reindex job: changing model or dimensions means running describe again.

## Security and reliability

Every query is scoped by `tenant_id`. Errors and logs redact the API key. A failed embedding never fails a description or an asset. Delete and retention remove vectors with the asset.

## Migration

`filevora migrate` creates the table for new databases. There is no backfill.

## Tests

`test/search.test.ts` covers embedding requests, normalization, ranking, ties, pagination, `maxResults`, lifecycle, errors, HTTP, client, and MCP. `test/search-calibration.test.ts` prints precision and recall per threshold for a labeled fixture. Its offline run uses a mock model.
