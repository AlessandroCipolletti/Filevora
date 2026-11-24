# DELIVERY_IP_DENIED

The delivery URL is bound to a different client IP.

Category: `auth`. HTTP 403. Retryable: false.

`signUrl` was called with `ip`. The request IP, from `x-forwarded-for` or `x-real-ip`, does not match that claim.

- resign: Sign again for the client that will fetch the file, or omit `ip`.
