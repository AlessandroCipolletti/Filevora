# EMBEDDING_UNAVAILABLE

The search query could not be turned into a vector. Filevora calls the Gemini embedding model (`FILEVORA_EMBEDDING_MODEL`, default `gemini-embedding-001`) once per new query. The call timed out, was rate limited after retries, returned a 5xx, or returned a vector with the wrong size.

Category: `processing`. HTTP 503. Retryable: true.

Nothing is stored or lost. Retry with backoff. Pages after the first reuse the cached query vector, so paging does not call Gemini again.

- retry_search: Retry the search after a short delay. If it keeps failing, check `FILEVORA_GEMINI_API_KEY`, `FILEVORA_EMBEDDING_MODEL`, and the Gemini quota.

Verify with `npx filevora doctor --json`. See [semantic search](../search.md).
