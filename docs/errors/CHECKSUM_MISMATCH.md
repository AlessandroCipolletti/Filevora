# CHECKSUM_MISMATCH

The stored checksum does not match the expected checksum.

Category: `upload`. HTTP 422. Retryable: false.

SHA-256 of the assembled object differs from the checksum supplied by the client.

- reupload: Upload the file again. Do not ignore a checksum mismatch.
