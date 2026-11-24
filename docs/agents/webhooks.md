# Completion webhooks

Webhooks are optional. Leave `FILEVORA_WEBHOOK_URL` unset and the SDK only reports progress over SSE.

Set the URL and secret in the environment, or pass `webhook: { url, secret }` on an upload session, `POST /assets/from-url`, or `POST /files/:assetId/transform`. A per-request URL overrides the environment URL. The secret falls back to `FILEVORA_WEBHOOK_SECRET`. The secret is stored for delivery and is omitted from asset responses.

Events:

- `upload.completed` when the original is stored and accepted
- `processing.completed` or `processing.failed` when encoding finishes
- `transform.completed` when a transform finishes

The JSON body is the same object as the terminal SSE event (`assetId`, `phase`, `state`, `percentage`, `terminal`, and `versions` with URLs). The event name is the `X-Filevora-Event` header.

Each request is signed. `X-Filevora-Timestamp` is unix seconds. `X-Filevora-Signature` is `sha256=` plus HMAC-SHA256 of `timestamp + "." + rawBody` using the webhook secret.

Delivery is a BullMQ job on the processing queue. It retries with the queue's exponential backoff. A 4xx response is not retried. A 5xx response is.

Targets use the same SSRF checks as URL import: http or https, no credentials, no private, link-local, or metadata addresses. `FILES_WEBHOOKS_ALLOW_LOOPBACK=true` (the default outside production) allows `localhost`, `127.0.0.1`, and `::1` on any port. That opt-in does not allow other private addresses, and it does not apply to URL-import redirects.
