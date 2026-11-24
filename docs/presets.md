# Presets

A preset is a name for a transform. Upload, URL import, and `POST /files/:assetId/transform` accept that name instead of raw width and height. The same preset works in lite and stored mode. Versions show up on `GET /files/:assetId/versions` and on the progress event, with the same signed URLs as any other version.

`web-optimized` is the default (`FILES_DEFAULT_PRESET`). It is the existing image and video pipeline: WebP thumbnail, optimized, and HD for images, a poster plus H.264 renditions for video, and AAC for audio.

## Built-in presets

Image versions are WebP. `contain` does not enlarge the source. `cover` crops to the exact box and may upscale. Video renditions are H.264 MP4 with AAC and may upscale to the named height. The original file stays in place when the preset runs at upload time.

| Preset | Media | Versions | What it produces |
| --- | --- | --- | --- |
| `web-optimized` | image, video, audio | `thumbnail`, `optimized`, `hd` (audio: `optimized` only) | Image WebP at 320, 1280, and 1920 wide, without enlargement. Video poster plus 720p, and 1080p when the source is taller than 720. Audio AAC in an M4A file. |
| `thumbnail` | image | `thumbnail` | WebP, 320 wide, contain. |
| `avatar` | image | `avatar` | WebP, 512×512, cover. |
| `og-image` | image | `og` | WebP, 1200×630, cover. |
| `hero` | image | `hero` | WebP, 1920 wide, contain. |
| `social-square` | image | `square` | WebP, 1080×1080, cover. |
| `video-480p` | video | `480p` | MP4 scaled to 480px tall. |
| `video-720p` | video | `720p` | MP4 scaled to 720px tall. |
| `video-1080p` | video | `1080p` | MP4 scaled to 1080px tall. |
| `video-preview` | video | `preview` | First 5 seconds, scaled to 480px tall. A shorter source is not padded. |
| `poster` | video | `poster` | One WebP frame from the start, at most 1280 wide. |

`video-1080p` fails when `FILES_VIDEO_MAX_OUTPUT_HEIGHT` is below 1080.

## Upload and URL import

```ts
await files.createUploadSession(
  { filename: 'face.png', mimeType: 'image/png', bytes, preset: 'avatar' },
  ctx,
);
```

```json
{ "url": "https://cdn.example/photo.jpg", "preset": "og-image" }
```

The preset is stored on the asset and expanded when the original is verified. An unknown name fails the session. A name that does not match the sniffed type fails completion with `TRANSFORM_REJECTED`. `context.validPresets` lists the names for that type.

## Transform

```json
{ "preset": "thumbnail" }
```

A single-output preset becomes its operations and follows `replace` (default true). Extra operations run after the preset:

```json
{
  "preset": "avatar",
  "operations": [{ "op": "image.resize", "width": 128, "height": 128, "fit": "cover" }]
}
```

`web-optimized` and `poster` add versions on the same asset instead of replacing the original. Passing `operations` together with those presets is rejected. Use a single-output preset, or send `operations` alone.

## Custom presets

In config:

```ts
createFiles({
  presets: {
    badge: {
      family: 'image',
      version: 'badge',
      operations: [{ op: 'image.resize', width: 64, height: 64, fit: 'cover' }],
    },
  },
});
```

Or `FILEVORA_PRESETS` as the same JSON object. Explicit `presets` in code wins over the environment variable. Names must be lowercase and must not reuse a built-in name. Each operation must match `family` (`image` or `video`) and the transform schema (`image.resize`, `image.crop`, `video.resize`, `video.crop`, `video.trim`, `video.poster`). `video.resize` may omit `width`; height is scaled and the width stays even. `video.poster` is stored as a version.

`filevora doctor` reports the default preset and any custom names. `filevora init` writes `FILES_DEFAULT_PRESET=web-optimized` into the env template.

`listPresets()` from `filevora/server` returns the built-in and custom summaries.
