# UPLOAD_SESSION_EXPIRED

The upload session has expired.

Category: `upload`. HTTP 410. Retryable: false.

The session TTL elapsed before completion. Parts from that session are not reusable.

- new_session: Create a new upload session and send the remaining bytes under the new id.
