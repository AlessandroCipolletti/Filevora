# Asset descriptions

Human guide: [docs/descriptions.md](../descriptions.md).

- Stored mode only. Lite mode, a Gemini key, `FILEVORA_DESCRIBE_ASSETS=true`, or `describe: true` returns `DESCRIPTION_REQUIRES_DATABASE`. Set `FILEVORA_DATABASE_URL` (`postgres://`, `mysql://`, or `sqlite://./filevora.sqlite`) and run `npx filevora migrate`.
- `describe: true` without `FILEVORA_GEMINI_API_KEY` returns `DESCRIPTION_NOT_CONFIGURED`. The message names that variable.
- Omit `describe` to use `FILEVORA_DESCRIBE_ASSETS` (default false). `describe: false` wins over a true default.
- Pass `describe` on `POST /sessions`, `POST /assets/from-url`, `POST /uploads/direct`, `POST /uploads/direct/:sessionId/complete`, `POST /pdf/merge`, and `POST /files/:id/split`.
- `POST /files/:assetId/describe` retriggers. `GET /files/:id` includes `description` (`long`, `short`, `status`, `error`, `describedAt`, `model`, `tags`). `GET /files` tag and text filters need stored mode and a Gemini key. See `docs/agents/list.md`.
- Status `failed` does not change `processing_state`. The job uses BullMQ and does not block asset creation.
- Model default is `gemini-3.5-flash-lite` (`FILEVORA_GEMINI_MODEL`). Video proxy height is `FILEVORA_DESCRIBE_VIDEO_HEIGHT` (default 720).
- Tags: image/video `subject|action|style|purpose|emotion`. Audio `kind|language`. PDF/text `subject|purpose|language`.
- Privacy: a smaller derivative (or the original for PDF/text) is sent to Google only when a description runs. The key is not logged. Uploaded Gemini files are deleted.
