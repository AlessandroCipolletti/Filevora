# Asset descriptions

Filevora can describe an image, video, audio file, or PDF with Google Gemini and store the result on the asset row. Nothing is sent to Google unless a description actually runs.

## When a description runs

`describe` on an upload, URL import, or direct S3 registration overrides `FILEVORA_DESCRIBE_ASSETS` for that asset.

- `describe: true` runs a description when a Gemini key and a database are configured.
- `describe: false` does not, even if the default is on.
- Omit `describe` and the default `FILEVORA_DESCRIBE_ASSETS` applies. The default is `false`.

The work is a BullMQ job. Creating the asset does not wait for Gemini and a failed description does not fail the asset. `description_status` is `pending`, `done`, or `failed`. `description_error` explains a failure. `described_at` and `description_model` record the success.

`POST /files/:assetId/describe` runs it again for an asset that already exists. When a description finishes, its text is also embedded for [semantic search](search.md). A failed embedding does not fail the description.

## Stored mode only

Descriptions and tags live in the host database (`description_long`, `description_short`, and `filevora_asset_tags`) so list and tag queries stay fast. Lite mode has no database. If the Gemini key is set, `FILEVORA_DESCRIBE_ASSETS` is true, or a request passes `describe: true`, lite mode returns `DESCRIPTION_REQUIRES_DATABASE`.

```bash
FILEVORA_DATABASE_URL=postgres://user:password@127.0.0.1:5432/app
FILEVORA_DATABASE_URL=mysql://user:password@127.0.0.1:3306/app
FILEVORA_DATABASE_URL=sqlite://./filevora.sqlite
npx filevora migrate
```

Set `FILEVORA_GEMINI_API_KEY` as well. Without that key, `describe: true` returns `DESCRIPTION_NOT_CONFIGURED`.

## What Gemini receives

The job starts when a smaller copy exists and keeps going beside later encodes:

- Images: the web-optimized 1280px WebP.
- Video: the existing optimized H.264 file. `FILEVORA_DESCRIBE_VIDEO_HEIGHT` defaults to 720. Another height makes a separate proxy.
- Audio: a compressed mono AAC copy. Speech descriptions summarise what is said. Music and effects describe the sound.
- PDFs and text: the original. Inputs over 15 MiB use the Gemini Files API and the uploaded file is deleted afterwards.

`FILEVORA_GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`. `gemini-2.5-flash` still accepts calls until 1 December 2026, then Google routes it to Gemini 3.5 Flash-Lite. The response is JSON with `description_long` (3000 characters), `description_short` (300 characters), and tags. Tags are lowercase, deduplicated, and limited to 12.

Image and video tag categories are `subject`, `action`, `style`, `purpose`, and `emotion`. Audio categories are `kind` (`music`, `sound-effects`, `speech`) and `language`. PDF and text categories are `subject`, `purpose`, and `language`.

`GET /files/:id` includes `description` when one was requested. `GET /files?tag=landscape` filters stored assets by tag when `FILEVORA_GEMINI_API_KEY` is set. `q`, `tags`, `tagsAll`, `descriptionStatus`, and `hasDescription` use the same rule. See [list filters](list.md).

Content is sent to Google only for that job. The API key is not logged.
