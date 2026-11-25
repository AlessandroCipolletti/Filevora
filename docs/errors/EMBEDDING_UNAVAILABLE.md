# EMBEDDING_UNAVAILABLE

A text could not be turned into a vector. Filevora calls the Gemini embedding model (`FILEVORA_EMBEDDING_MODEL`, default `gemini-embedding-001`) once for each new search query, and once for each description when it finishes.

Category: `processing`. HTTP 503. Retryable: depends on the cause. Read `retryable` on the error.

Nothing is stored or lost. Pages after the first reuse the cached query vector, so paging does not call Gemini again.

When Google answers with an error, the message names Google's HTTP status and its error text. `context` carries the same values. It never contains the API key or the request URL.

| `context` field    | Meaning                                                         |
| ------------------ | --------------------------------------------------------------- |
| `geminiHttpStatus` | HTTP status from Google, for example `400`                      |
| `geminiStatus`     | `error.status` from Google's body, for example `INVALID_ARGUMENT` |
| `geminiMessage`    | `error.message` from Google's body                              |
| `geminiReason`     | First `error.details[].reason`, for example `API_KEY_INVALID`   |

| Cause                                                            | Retryable | Fix                                                                                                                                                         |
| ---------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 429, 5xx, timeout, or a vector with the wrong size               | true      | Retry with backoff (Filevora already retried 429 and 5xx three times). If it keeps failing, check the Gemini quota.                                       |
| 400, usually `API_KEY_INVALID`                                   | false     | Set a valid `FILEVORA_GEMINI_API_KEY`. If `geminiMessage` names a field instead, check `FILEVORA_EMBEDDING_MODEL` and `FILEVORA_EMBEDDING_DIMENSIONS`.       |
| 401                                                              | false     | The key is missing or invalid. Set `FILEVORA_GEMINI_API_KEY`.                                                                                               |
| 402                                                              | false     | Billing is not enabled or the account has no credit. Enable billing or add credit for the Google project that owns the key.                                |
| 403                                                              | false     | The key has no permission. Enable the Generative Language API for its project, lift any key restriction that blocks it, and check `FILEVORA_EMBEDDING_MODEL`. |

- retry_search: For 429, 5xx, a timeout, or a bad vector, retry after a short delay.
- fix_gemini_key: For 400 or 401, set a valid `FILEVORA_GEMINI_API_KEY`.
- enable_gemini_billing: For 402, enable billing or add credit.
- enable_gemini_api: For 403, enable the Generative Language API and check key restrictions.

Verify with `npx filevora doctor --json`. See [semantic search](../search.md).
