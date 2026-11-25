# Semantic search

`POST /files/semantic-search` finds assets by meaning. Send a natural-language prompt in any language and get a paginated list of matching assets, each with a similarity `score`. It needs stored mode and `FILEVORA_GEMINI_API_KEY`. No new service is required: vectors live in your host database and the ranking runs in your Node process.

## How it works

1. When a Gemini description finishes, Filevora builds one canonical text from the asset type, MIME type, short and long description, and tags. It sends that text together with a rendition of the file in one `embedContent` request to `gemini-embedding-2` at 768 dimensions, and stores a unit-length float32 vector in `filevora_asset_embeddings`. The vector therefore covers what the file looks or sounds like and what the description says. Each row records its `model` and its `source`: `file+description`, or `description` when the file could not be sent.
2. A search embeds the text prompt once with the same model, applies every structured filter in SQL, reads the remaining vectors in keyset chunks, and keeps only the best page in memory. Similarity is the cosine, which for unit vectors is the dot product. Nothing is precomputed per query, so a new asset is searchable as soon as its embedding row exists.
3. Results are ordered by `score` descending, then asset id descending, so ties never reorder between pages.

## What is embedded with the description

Filevora never sends the original upload when its own pipeline can make a rendition in a format Google accepts. A file that does not fit, or that cannot be read or rendered, never fails the asset: the description is embedded alone, the row says `description`, and one line goes to stderr with the reason. The fixed limits come from the `gemini-embedding-2` input limits (8192 input tokens per request; the description text is clipped to 8000 characters).

| Type                                                           | What is sent                                                                                                                                                                                                                                                                                                                                                                                                                                                | Falls back to description only when                                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Image, any format (JPEG, PNG, WebP, HEIC, AVIF, SVG, GIF, ...) | A JPEG made by our own image pipeline (`sharp`), long edge at most 1024 px, quality 85. A PNG instead when the image has real transparency. It is rendered from the stored `optimized` version when there is one, otherwise from the original. Google counts a fixed 258 tokens per image, so a larger size would only cost upload time.                                                                                                                    | The decoder cannot read it (for example HEIC without HEVC support), it exceeds `FILEVORA_IMAGE_MAX_PIXELS`, or the original is over 64 MiB |
| Video                                                          | The `optimized` MP4 (H.264, at most 720 p) that the pipeline already makes. When there is none, the original only if it is MP4 or MOV with an H.264, H.265, AV1, or VP9 track. Google reads 32 frames and ignores the audio track.                                                                                                                                                                                                                          | Longer than 120 s, a file over 12 MiB, or any other container or codec                                                                     |
| Audio                                                          | An MP3 or WAV rendition when the pipeline made one, otherwise the original when it is MP3 or WAV within 180 s and 12 MiB. Anything else (M4A, AAC, OGG, FLAC, a longer MP3 or WAV) is converted by ffmpeg to a mono 64 kbps MP3 used for embedding only and never stored, from the `optimized` M4A when there is one, otherwise from the original. The conversion is trimmed to 180 s, because the limit is on duration. Temp files are removed afterwards. | ffmpeg is missing or fails, or the MP3 would pass 12 MiB (it cannot at 64 kbps and 180 s)                                                  |
| PDF                                                            | The original file, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                               | More than 6 pages, a file over 12 MiB, or a PDF that cannot be parsed (for example encrypted)                                              |
| Text, CSV, Office, other                                       | Nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Always: these are embedded from the description                                                                                            |

Files over 12 MiB are not sent because the request carries the file as base64 and a request may not pass 20 MiB. If Google answers 400 or 413 to a file anyway, the description is embedded alone and the reason is logged; other failures (key, billing, quota, 5xx) are errors as before.

## Request

```http
POST /files/semantic-search
content-type: application/json

{ "query": "animali che giocano", "type": "image", "createdFrom": "2026-10-01", "minScore": 0.65, "maxResults": 100, "limit": 20 }
```

`query` is required, 1 to 2000 characters after trimming. The structured filters are the ones `GET /files` accepts (`type`, dates, `tags`, `tagsAll`, `tagCategory`, `mime`, `filename`, sizes, dimensions, duration, `status`, `visibility`, `preset`). `q`, `sort`, and `order` do not apply; ordering is always by score.

## Result selection

| Field        | Meaning                                                                               | Default                            | Range     |
| ------------ | ------------------------------------------------------------------------------------- | ---------------------------------- | --------- |
| `minScore`   | Minimum cosine similarity. Equivalent to a maximum vector distance of `1 - minScore`. | `FILEVORA_SEMANTIC_SEARCH_MIN_SCORE`, 0.65  | 0 to 1    |
| `maxResults` | Hard cap on results across all pages.                                                 | `FILEVORA_SEMANTIC_SEARCH_MAX_RESULTS`, 100 | 1 to 1000 |
| `limit`      | Page size. Clamped to what is left under `maxResults`.                                | 20                                 | 1 to 100  |
| `cursor`     | `nextCursor` of the previous page.                                                    | none                               |           |

Every field can be set per request. The environment values only provide the defaults.

The response:

```json
{
  "items": [
    {
      "score": 0.683214,
      "file": { "id": "file_...", "description": { "short": "..." } }
    }
  ],
  "nextCursor": "eyJ2IjoxLC4uLn0",
  "meta": {
    "model": "gemini-embedding-2",
    "dimensions": 768,
    "minScore": 0.65,
    "maxResults": 100,
    "candidatesScored": 4210,
    "capped": false
  }
}
```

`score` is rounded to six decimals. `nextCursor` is `null` on the last page. `meta.capped` is true when more matches exist than `maxResults` allowed, so the list was cut. Raise `maxResults`, raise `minScore`, or add filters.

Keep `query`, `minScore`, `maxResults`, model, and every filter unchanged when you send `nextCursor` back. A cursor from a different search returns `SEMANTIC_SEARCH_QUERY_INVALID`. Later pages reuse the cached query vector, so they do not call Gemini again.

### The 0.65 default is provisional

`0.65` is provisional. It comes from one live run of the text fixture in this repository with `gemini-embedding-2` and descriptions only: at 0.65 precision was 0.77 and recall 0.82, while the old default 0.55 gave a precision of 0.06 (nearly everything matched). It has not been confirmed on real files with file-plus-description vectors, and the fixture is small and hand-labeled. Embedding models give unrelated texts a high baseline cosine, so a sensible threshold is well above zero but its exact value depends on your descriptions. Calibrate it before relying on it (run `pnpm build` first):

1. Describe a representative sample of your assets.
2. Run `FILEVORA_CALIBRATION_GEMINI_KEY=... node --experimental-strip-types --test test/search-calibration.test.ts` from `packages/filevora`. It prints precision, recall, and F1 for `minScore` 0.50 to 0.80 in 0.01 steps, and the top results per query, over `test/fixtures/search-calibration.json`.
3. To calibrate with real files instead of descriptions alone, put your own files and a labels file in a folder and set `FILEVORA_CALIBRATION_FILES_DIR` (see below). Then set `FILEVORA_SEMANTIC_SEARCH_MIN_SCORE`.

The fixture in this repository is hand-written: 37 assets (documents, photos, screenshots, slides, spreadsheets, audio, video, with a few near-duplicates) and 25 labeled queries, 3 of which have no relevant asset. The labels were assigned by the author, so treat any threshold from it as a rough guide only. The offline run uses a mock embedding model that only models a few concepts, so it only proves the harness works.

### Calibrate with your own files

You only need your files and your queries. Everything else is generated.

1. Copy your sample files into `packages/filevora/test/calibration-files/`. The folder is gitignored, so nothing in it is ever committed. Every file with a known extension (images, PDF, MP3, WAV, M4A, MP4, MOV, TXT, CSV, and so on) becomes one asset, named by its file name.
2. In the same folder, create `labels.json` and write your queries there. Each query has the `text` a user would type and the `relevant` file names that should be found for it. Use `"relevant": []` for a query that should find nothing:

```json
{
  "queries": [
    { "text": "holiday by the sea", "relevant": ["beach.jpg"] },
    { "text": "how much do we owe the supplier", "relevant": ["invoice.pdf"] },
    { "text": "a snowy mountain", "relevant": [] }
  ]
}
```

3. Run it from `packages/filevora` after `pnpm build`:

```bash
FILEVORA_CALIBRATION_GEMINI_KEY=... FILEVORA_CALIBRATION_FILES_DIR=test/calibration-files \
  node --experimental-strip-types --test test/search-calibration.test.ts
```

A complete example is `test/fixtures/calibration-files.labels.example.json`.

**Descriptions.** For each file the harness runs the same Gemini describe code as an upload (same prompt, length limits, and tag rules, model `FILEVORA_GEMINI_MODEL` or the default) and caches the result in `descriptions.cache.json` inside the folder (gitignored). A re-run reuses the cache and spends nothing on descriptions. The cache entry is dropped when the file changes or the model changes. The harness sends the rendition (for images, the 1024 px JPEG) to describe, not the 1280 px WebP derivative a real upload uses, so descriptions can differ slightly. To write a description yourself, add an `assets` entry with `file`, `short`, `long`, and `tags` (a list of `["category", "tag"]` pairs); any of the three you leave out is generated.

**Renditions.** Each file goes through the same renditions as above and is embedded together with its description. `ffprobe` and `ffmpeg` must be on the path (or set `FILES_FFPROBE_PATH` and `FILES_FFMPEG_PATH`) for audio and video, because the harness has no stored renditions.

**Reading the output.** The same output is printed for the real-files run and the live text-fixture run, in this order:

1. `Embedded as file+description: N of M` says how many assets were embedded with their file.
2. `Files not sent with their description` lists every file that fell back to the description only, with the reason: a file that failed to render, was over a limit, had an unsupported type, or was rejected by Google. If it says `none`, every file was sent.
3. `Per query` shows, for each query, the top 5 results as `rank. mark file score`. `+` means the file is in that query's `relevant` list, `-` means it is not. A score is the cosine similarity, the same number a search returns, shown with 2 decimals. `missed in top 10` names the relevant files that are not in the first 10 results, with their real rank and score; `none` means every relevant file was in the top 10. A query with no relevant files has no `missed` line: there, any result above your `minScore` would be a false positive, so look at the top score.
4. The sweep table has one line per `minScore` from 0.50 to 0.80 in 0.01 steps, with precision (how many returned files were relevant), recall (how many relevant files were returned), and F1 (their balance). The line marked `<- best F1` is the best balance, and the last line repeats it.

To pick a threshold, find the best-F1 line, then check the per-query lists: a good `minScore` sits below the scores of the `+` results and above the scores of the `-` results.

## Indexing lifecycle

- Embedding runs at the end of the description job, after the description is stored. A failed embedding does not fail the description or the asset. The asset is left out of search until the next successful describe.
- `POST /files/:id/describe` runs the description again and replaces the embedding, including for a ready image or video.
- Deleting an asset removes its vector. Retention that deletes bytes removes it too.
- Embedding sends the file rendition to Google together with the description, so the same Google API key and quota apply as for descriptions.
- Changing `FILEVORA_EMBEDDING_MODEL` or `FILEVORA_EMBEDDING_DIMENSIONS` does not rewrite old vectors. Search only reads vectors of the current model and dimension, so run `describe` again for the assets you want searchable under the new setting. There is no bulk reindex.

## Scale

Search is exact, not approximate. Every vector that passes the SQL filters is scored on each new query. Time grows linearly with the number of filtered embedded assets and each vector is 3 KB at 768 dimensions. Use filters to narrow big libraries. The scan streams 5000 rows at a time, so memory stays bounded.

## Configuration

| Variable                        | Default              |
| ------------------------------- | -------------------- |
| `FILEVORA_EMBEDDING_MODEL`      | `gemini-embedding-2` |
| `FILEVORA_EMBEDDING_DIMENSIONS` | `768` (128 to 3072)  |
| `FILEVORA_SEMANTIC_SEARCH_MIN_SCORE`     | `0.65` (provisional) |
| `FILEVORA_SEMANTIC_SEARCH_MAX_RESULTS`   | `100`                |

The Gemini key is `FILEVORA_GEMINI_API_KEY`. `gemini.embeddingModel`, `gemini.embeddingDimensions`, `gemini.semanticSearchMinScore`, and `gemini.semanticSearchMaxResults` are the matching `createFiles` options.

## Errors

| Code                            | Status | Meaning                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESCRIPTION_REQUIRES_DATABASE` | 422    | Lite mode. Set `FILEVORA_DATABASE_URL`.                                                                                                                                                                                                                                                                                                               |
| `DESCRIPTION_NOT_CONFIGURED`    | 422    | No `FILEVORA_GEMINI_API_KEY`.                                                                                                                                                                                                                                                                                                                         |
| `SEMANTIC_SEARCH_QUERY_INVALID`          | 400    | Bad query, filter, range, or cursor.                                                                                                                                                                                                                                                                                                                  |
| `EMBEDDING_UNAVAILABLE`         | 503    | The embedding call failed. The message and `context` carry Google's status and error text. Retry 429, 5xx, and timeouts with backoff. 400 (usually an invalid key), 401, 402 (billing or credit), and 403 (permission or API not enabled) have `retryable: false`; fix the cause first. See [EMBEDDING_UNAVAILABLE](errors/EMBEDDING_UNAVAILABLE.md). |

## SDK and MCP

`createUploadClient().semanticSearch('animali che giocano')` or `.semanticSearch({ query, minScore, maxResults, limit, cursor })`. The `filevora mcp` tool `semantic_search_assets` runs the search live against `FILEVORA_DATABASE_URL` and `FILEVORA_GEMINI_API_KEY` from the MCP process environment (or its `env` argument). It requires `tenantId`, because the MCP process has no signed-in user.
