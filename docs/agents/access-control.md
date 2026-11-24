# Access control

No users, teams, or roles. The host authenticates. Filevora only distinguishes `public` and `private` assets.

- Default visibility is `private` via `FILEVORA_DEFAULT_VISIBILITY`. Upload and `POST /assets/from-url` accept `visibility`. `PUT /files/:assetId/visibility` changes it. Public requires `FILES_ALLOW_PUBLIC_FILES=true`.
- Stored mode: columns `visibility` and `url_salt` on `filevora_assets`. Migrations add `url_salt` on Postgres, MySQL, and SQLite.
- Lite mode: both fields live on the asset card `{storageRoot}/.filevora/files/{assetId}.json`, next to `last_accessed_at`. A missing card is private.
- `FILEVORA_SIGNING_SECRET` is one secret or a comma-separated list. Index 0 signs. All entries verify.
- `files.signUrl(assetId, { version, expiresIn, download?, ip?, baseUrl? }, ctx)` returns `{ url, expiresAt }` and sets `last_accessed_at`.
- `verifyDeliveryToken(token, secrets)` throws `DELIVERY_MALFORMED`, `DELIVERY_BAD_SIGNATURE`, or `DELIVERY_EXPIRED`.
- `GET /content/:token` also enforces the asset salt and optional IP. Salt mismatch is `DELIVERY_REVOKED`. IP mismatch is `DELIVERY_IP_DENIED`. Missing target is `DELIVERY_NOT_FOUND`. All of these are HTTP 403.
- `POST /files/:assetId/revoke-urls` rotates `url_salt`.
- Private responses (progress, webhooks, versions) use `/content` tokens. S3 originals use a presigned URL, not a bare object URL.
- Public responses use `/public/:assetId/:version`. That route is unauthenticated and returns `DELIVERY_PRIVATE` unless visibility is `public`.
- `signTestDeliveryUrl` from `filevora/testing` signs with `filevora-test-signing-secret`.
- Doctor check `signing` warns `DOCTOR_SIGNING_SECRET` when private mode has no secret. Init writes the secret and `FILEVORA_DEFAULT_VISIBILITY=private`.

Human table and examples: [docs/access-control.md](../access-control.md).
