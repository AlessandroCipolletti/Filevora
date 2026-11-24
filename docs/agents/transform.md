# Transform an asset

`POST /files/:assetId/transform` queues one transform and returns immediately.

```json
{
  "launched": true,
  "jobId": "job_…",
  "assetId": "file_…",
  "sourceAssetId": "file_…",
  "replace": true
}
```

`replace` defaults to `true`: the same `assetId` is kept, the original file is replaced, and stored mode updates the database row. `false` creates a new `assetId` and leaves the source asset in place.

The config is one object. `operations` is a list of discriminated steps. Unknown keys are rejected.

```json
{
  "replace": true,
  "operations": [
    { "op": "image.crop", "x": 0, "y": 0, "width": 200, "height": 200 },
    { "op": "image.resize", "width": 320, "height": 320, "fit": "cover" }
  ]
}
```

```json
{
  "operations": [
    { "op": "video.crop", "x": 0, "y": 0, "width": 640, "height": 360 },
    { "op": "video.trim", "startMs": 1000, "endMs": 4000 },
    { "op": "video.resize", "width": 320, "height": 180 }
  ]
}
```

```json
{ "operations": [{ "op": "pdf.removePages", "pages": [2, 4] }] }
```

Valid operations depend on the sniffed original, not the filename:

- `image/*`: `image.resize`, `image.crop`
- `video/*`: `video.resize`, `video.crop`, `video.trim`, `video.poster`, `video.thumbnails`, `video.sprite`
- `application/pdf`: `pdf.removePages`, `pdf.pages`

`pdf.pages` renders selected pages, or every page when `pages` is omitted, with Poppler's `pdftoppm`. `format` is `png`, `jpeg`, or `webp`. `dpi` is 36–300. `width` and `height` bound the image. Presets `pdf-pages` and `pdf-cover` do the same. A missing `pdftoppm` is `PROCESSOR_UNAVAILABLE`. Install Poppler (`poppler-utils` on Debian and Ubuntu, `brew install poppler` on macOS). Text extraction does not need it. More than 50 pages requires an explicit `pages` list.

`video.poster`, `video.thumbnails`, and `video.sprite` publish versions on the same asset. They can be sent alone, or as the `poster`, `thumbnails`, and `sprites` presets. Mixing one of them with `video.resize`, `video.crop`, or `video.trim` is `TRANSFORM_REJECTED`. `video.poster` takes `atMs` or `atPercent`. `video.thumbnails` takes `count`, `intervalMs`, `atMs`, or `atPercent`. `video.sprite` takes `columns`, `rows`, and optional `cellWidth` and `intervalMs`, and also writes `{version}-vtt` (`text/vtt`) and `{version}-json`.

Lite mode looks for `{tenantHash}/{assetId}_original.*` in object storage. A missing object is `ASSET_NOT_FOUND`. Stored mode reads the metadata database.

A bad config is `TRANSFORM_REJECTED` before a job starts. `context.field` is the key, `context.reason` says why, `context.detectedType` is the sniffed type, and `context.validOperations` lists what that type accepts.

```ts
import { createFiles } from 'filevora/server';

const files = createFiles();
const job = await files.transform('file_…', {
  operations: [{ op: 'image.resize', width: 640 }],
}, { principal });
```

```ts
const client = createUploadClient({ endpoint: 'https://app.example/api/files' });
const job = await client.transform('file_…', {
  replace: false,
  operations: [{ op: 'pdf.removePages', pages: [1] }],
});
```

Progress for upload, URL download, and this transform is `GET /files/:assetId/progress`. The JSON and SSE body use the same fields: `fileId`, `assetId`, `jobId`, `phase` (`upload`, `download`, or `processing`), `state`, `percentage`, `etaMs`, `quiet`, `terminal`, optional `errorCode`. The terminal success event adds `versions`, including `_original.url`.

Image resize and crop use Sharp. Video uses FFmpeg. PDF page removal uses pdf-lib. The job runs on the BullMQ queue.
