# IDEMPOTENCY_CONFLICT

The idempotency key was already used for a different request.

Category: `upload`. HTTP 409. Retryable: false.

Repeat the original request body or choose a new idempotency key.

- reuse_or_new: Retry the same payload to receive the original session, or send a new key.
