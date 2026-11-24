# DELIVERY_BAD_SIGNATURE

The delivery signature does not match the configured keys.

Category: `auth`. HTTP 403. Retryable: false.

The HMAC was computed with a different secret, or the payload was edited. During key rotation the previous key must stay in `FILEVORA_SIGNING_SECRET` until tokens signed with it expire.

- check_keys: Keep the previous key in the comma-separated `FILEVORA_SIGNING_SECRET` list.
