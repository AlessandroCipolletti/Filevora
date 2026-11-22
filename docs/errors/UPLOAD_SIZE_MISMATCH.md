# UPLOAD_SIZE_MISMATCH

The stored object size does not match the authorized size.

Category: `upload`. HTTP 422. Retryable: false.

The concatenated parts are a different length than the size authorized at session creation.

- restart: Abort the session and upload the file again with the correct size.
