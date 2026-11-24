# DELIVERY_MALFORMED

The delivery token is not a signed payload.

Category: `auth`. HTTP 403. Retryable: false.

The value is not a base64 JSON body plus an HMAC, or the signed body is not the expected object.

- sign_again: Call `signUrl` again and use the returned URL unchanged.
