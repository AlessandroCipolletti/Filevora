# Access control

Filevora does not have users, teams, or roles. Your application authenticates the caller. Filevora decides who can fetch bytes.

## Visibility

Each asset is `private` or `public`. The default is `private` (`FILEVORA_DEFAULT_VISIBILITY`). Set it on upload or URL import, and change it later:

```json
PUT /files/:assetId/visibility
{ "visibility": "public" }
```

`public` is rejected unless `FILES_ALLOW_PUBLIC_FILES=true` or `defaults.allowPublicFiles` is set.

Stored mode keeps `visibility` on `filevora_assets`. Lite mode keeps it on the asset card at `{storage}/.filevora/files/{assetId}.json`, the same JSON object that stores `last_accessed_at`. A missing card is private. It is never treated as public.

## Signed URLs

`FILEVORA_SIGNING_SECRET` is one secret, or a comma-separated list. The first key signs new URLs. Every key verifies, so you can rotate by putting the new key first and leaving the previous key in the list until old URLs expire.

```ts
const signed = await files.signUrl(
  assetId,
  { version: 'thumbnail', expiresIn: 900, download: 'thumb.webp', ip: '203.0.113.4' },
  ctx,
);
```

```ts
import { verifyDeliveryToken } from 'filevora/server';

const claims = verifyDeliveryToken(token, [currentKey, previousKey]);
```

The token is `base64url(payload).hmac`. The payload contains the asset id, version, expiry, the asset's `url_salt`, and the optional download name and IP. `GET /content/:token` checks the signature, expiry, salt, and IP. Failures are HTTP 403:

| Code | Cause |
| --- | --- |
| `DELIVERY_MALFORMED` | The token is not a signed payload. |
| `DELIVERY_BAD_SIGNATURE` | The HMAC matches none of the configured keys. |
| `DELIVERY_EXPIRED` | `exp` is in the past. |
| `DELIVERY_REVOKED` | The asset salt changed after the token was signed. |
| `DELIVERY_IP_DENIED` | The request IP does not match the `ip` claim. |
| `DELIVERY_NOT_FOUND` | The asset or version is gone. |
| `DELIVERY_PRIVATE` | `/public` was used for a private asset. |

Issuing a signed URL sets `last_accessed_at`, which retention uses as access time.

`POST /files/:assetId/revoke-urls` replaces `url_salt`. Stored mode keeps that column on `filevora_assets`. Lite mode keeps it on the asset card. Older URLs then return `DELIVERY_REVOKED`.

## What a client receives

Private assets: progress events, webhooks, and the versions route return signed `/content` URLs. When storage is S3, the original is an S3 presigned URL instead of a raw object URL. A URL with no signature cannot read the object. Cold `GET /content` and `GET /public` read the object through the storage driver, including `Range`. Lite cards for those assets live in the bucket, not on the API host's disk.

Public assets: those same responses use `/public/:assetId/:version`. That route does not require a principal and does not expire. It still refuses private assets.

Tests can mint a URL with `signTestDeliveryUrl` from `filevora/testing`. The test signing secret is `filevora-test-signing-secret`.

`filevora doctor` warns with `DOCTOR_SIGNING_SECRET` when the default visibility is private and no signing secret is set. `filevora init` writes `FILEVORA_DEFAULT_VISIBILITY=private` and a placeholder `FILEVORA_SIGNING_SECRET`.
