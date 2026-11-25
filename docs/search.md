# Semantic search

`POST /files/search` finds assets by meaning. Send a natural-language prompt in any language and get a paginated list of matching assets, each with a similarity `score`. It needs stored mode and `FILEVORA_GEMINI_API_KEY`. No new service is required: vectors live in your host database and the ranking runs in your Node process.

## How it works

1. When a Gemini description finishes, Filevora builds one canonical text from the asset type, MIME type, short and long description, and tags. It sends that text together with a rendition of the file in one `embedContent` request to `gemini-embedding-2` at 768 dimensions, and stores a unit-length float32 vector in `filevora_asset_embeddings`. The vector therefore covers what the file looks or sounds like and what the description says. Each row records its `model` and its `source`: `file+description`, or `description` when the file could not be sent.
2. A search embeds the text prompt once with the same model, applies every structured filter in SQL, reads the remaining vectors in keyset chunks, and keeps only the best page in memory. Similarity is the cosine, which for unit vectors is the dot product. Nothing is precomputed per query, so a new asset is searchable as soon as its embedding row exists.
3. Results are ordered by `score` descending, then asset id descending, so ties never reorder between pages.

## What is embedded with the description

Filevora never sends the original upload when its own pipeline can make a rendition in a format Google accepts. A file that does not fit, or that cannot be read or rendered, never fails the asset: the description is embedded alone, the row says `description`, and one line goes to stderr with the reason. The fixed limits come from the `gemini-embedding-2` input limits (8192 input tokens per request; the description text is clipped to 8000 characters).

| Type | What is sent | Falls back to description only when |
| --- | --- | --- |
| Image, any format (JPEG, PNG, WebP, HEIC, AVIF, SVG, GIF, ...) | A JPEG made by our own image pipeline (`sharp`), long edge at most 1024 px, quality 85. A PNG instead when the image has real transparency. It is rendered from the stored `optimized` version when there is one, otherwise from the original. Google counts a fixed 258 tokens per image, so a larger size would only cost upload time. | The decoder cannot read it (for example HEIC without HEVC support), it exceeds `FILEVORA_IMAGE_MAX_PIXELS`, or the original is over 64 MiB |
| Video | The `optimized` MP4 (H.264, at most 720 p) that the pipeline already makes. When there is none, the original only if it is MP4 or MOV with an H.264, H.265, AV1, or VP9 track. Google reads 32 frames and ignores the audio track. | Longer than 120 s, a file over 12 MiB, or any other container or codec |
| Audio | A rendition in MP3 or WAV when the pipeline made one. The default `optimized` rendition is M4A, which Google does not accept, so by default the original is sent, only if it is MP3 or WAV. | Longer than 180 s, a file over 12 MiB, or any other type (M4A, AAC, OGG, FLAC, ...) |
| PDF | The original file, unchanged. | More than 6 pages, a file over 12 MiB, or a PDF that cannot be parsed (for example encrypted) |
| Text, CSV, Office, other | Nothing. | Always: these are embedded from the description |

Files over 12 MiB are not sent because the request carries the file as base64 and a request may not pass 20 MiB. If Google answers 400 or 413 to a file anyway, the description is embedded alone and the reason is logged; other failures (key, billing, quota, 5xx) are errors as before.

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
  "meta": { "model": "gemini-embedding-2", "dimensions": 768, "minScore": 0.55, "maxResults": 100, "candidatesScored": 4210, "capped": false }
}
```

`score` is rounded to six decimals. `nextCursor` is `null` on the last page. `meta.capped` is true when more matches exist than `maxResults` allowed, so the list was cut. Raise `maxResults`, raise `minScore`, or add filters.

Keep `query`, `minScore`, `maxResults`, model, and every filter unchanged when you send `nextCursor` back. A cursor from a different search returns `SEARCH_QUERY_INVALID`. Later pages reuse the cached query vector, so they do not call Gemini again.

### The 0.55 default is not calibrated

`0.55` is a planning estimate, not a measurement. It was not measured with `gemini-embedding-2` and file-plus-description vectors, and no such run exists in this repository. Embedding models give unrelated texts a high baseline cosine, so a sensible threshold is well above zero but its exact value depends on your descriptions. Calibrate it before relying on it (run `pnpm build` first):

1. Describe a representative sample of your assets.
2. Run `FILEVORA_CALIBRATION_GEMINI_KEY=... node --experimental-strip-types --test test/search-calibration.test.ts` from `packages/filevora`. It prints precision and recall for `minScore` 0.45 to 0.70 over `test/fixtures/search-calibration.json`.
3. To calibrate with real files instead of descriptions alone, put your own files and a labels file in a folder and set `FILEVORA_CALIBRATION_FILES_DIR` (see below). Then set `FILEVORA_SEARCH_MIN_SCORE`.

The fixture in this repository is hand-written: 37 assets (documents, photos, screenshots, slides, spreadsheets, audio, video, with a few near-duplicates) and 25 labeled queries, 3 of which have no relevant asset. The labels were assigned by the author, so treat any threshold from it as a rough guide only. The offline run uses a mock embedding model that only models a few concepts, so it only proves the harness works.

### Calibrate with your own files

Create a folder that is not tracked by git (`packages/filevora/test/calibration-files/` is gitignored), copy sample files into it, and add a `labels.json` next to them. The folder content is never committed. The format is shown in `test/fixtures/calibration-files.labels.example.json`:

```json
{
  "assets": [
    { "file": "beach.jpg", "short": "A sunny beach.", "long": "A wide sandy beach with palm trees and a blue sea.", "tags": [["subject", "beach"]] }
  ],
  "queries": [
    { "text": "holiday by the sea", "relevant": ["beach.jpg"] },
    { "text": "tax invoice", "relevant": [] }
  ]
}
```

Run it from `packages/filevora` after `pnpm build`:

```bash
FILEVORA_CALIBRATION_GEMINI_KEY=... FILEVORA_CALIBRATION_FILES_DIR=test/calibration-files \
  node --experimental-strip-types --test test/search-calibration.test.ts
```

Each file goes through the same renditions as above and is embedded with its description. The table also prints how many assets were embedded as `file+description` and which fell back, with the reason. `ffprobe` must be on the path (or set `FILES_FFPROBE_PATH`) for audio and video files, because the harness has no stored renditions.

## Indexing lifecycle

- Embedding runs at the end of the description job, after the description is stored. A failed embedding does not fail the description or the asset. The asset is left out of search until the next successful describe.
- `POST /files/:id/describe` runs the description again and replaces the embedding, including for a ready image or video.
- Deleting an asset removes its vector. Retention that deletes bytes removes it too.
- Embedding sends the file rendition to Google together with the description, so the same Google API key and quota apply as for descriptions.
- Changing `FILEVORA_EMBEDDING_MODEL` or `FILEVORA_EMBEDDING_DIMENSIONS` does not rewrite old vectors. Search only reads vectors of the current model and dimension, so run `describe` again for the assets you want searchable under the new setting. There is no bulk reindex.

## Scale

Search is exact, not approximate. Every vector that passes the SQL filters is scored on each new query. Time grows linearly with the number of filtered embedded assets and each vector is 3 KB at 768 dimensions. Use filters to narrow big libraries. The scan streams 5000 rows at a time, so memory stays bounded.

## Configuration

| Variable | Default |
| --- | --- |
| `FILEVORA_EMBEDDING_MODEL` | `gemini-embedding-2` |
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
| `EMBEDDING_UNAVAILABLE` | 503 | The embedding call failed. The message and `context` carry Google's status and error text. Retry 429, 5xx, and timeouts with backoff. 400 (usually an invalid key), 401, 402 (billing or credit), and 403 (permission or API not enabled) have `retryable: false`; fix the cause first. See [EMBEDDING_UNAVAILABLE](errors/EMBEDDING_UNAVAILABLE.md). |

## SDK and MCP

`createUploadClient().search('animali che giocano')` or `.search({ query, minScore, maxResults, limit, cursor })`. The `filevora mcp` tool `search_assets` runs the search live against `FILEVORA_DATABASE_URL` and `FILEVORA_GEMINI_API_KEY` from the MCP process environment (or its `env` argument). It requires `tenantId`, because the MCP process has no signed-in user.
