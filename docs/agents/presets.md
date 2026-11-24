# Presets

Machine-oriented notes. The table of every built-in preset is in [docs/presets.md](../presets.md).

- Default name is `web-optimized` (`FILES_DEFAULT_PRESET`). It still runs the existing image, video, and audio processors.
- `FILES_THUMBNAIL_WIDTH` and `defaults.thumbnailWidth` are `320` or `480`. The default is `480` (it was `320`). That width is the web-optimized image `thumbnail`, the built-in `thumbnail` preset, and the legacy video `thumbnail` poster. Other sizes stay 1280, 1920, 720, and 1080. Any other value is `INVALID_CONFIG` and the message lists 320 and 480.
- Other built-in names expand to transform operations and are stored as versions at upload and URL import.
- `POST /files/:assetId/transform` accepts `preset`. Single-output presets append `operations` when both are set. `web-optimized`, `poster`, `thumbnails`, and `sprites` add versions and reject extra operations.
- `video.poster` accepts `atMs` or `atPercent`. `video.thumbnails` writes `thumb-1` onward. `video.sprite` writes the sheet plus `{version}-vtt` and `{version}-json`. Sending only those operations, with no preset, also publishes versions.
- `pdf.pages` writes `page-N` images through `pdftoppm`. Presets `pdf-pages` and `pdf-cover`. Omit `pages` to render every page, up to 50. `format` is `png`, `jpeg`, or `webp`. A missing binary is `PROCESSOR_UNAVAILABLE`.
- Unknown names and names for the wrong sniffed type throw `TRANSFORM_REJECTED`. `context.validPresets` is the list for that type. `context.detectedType` is the sniffed mime, or null when the name is unknown before sniffing.
- Custom presets: `presets` on `createFiles`, or `FILEVORA_PRESETS` JSON. Same operation schema as transform. A built-in name in that map is `INVALID_CONFIG`.
- Lite and stored both write the version row and the object key `{tenantHash}/{assetId}_{version}.{ext}`.
- `listPresets()` from `filevora/server` lists names, families, and version names.
- `filevora doctor` adds a `presets` check and includes the thumbnail width. `filevora init` writes `FILES_DEFAULT_PRESET=web-optimized` and `FILES_THUMBNAIL_WIDTH=480`.
