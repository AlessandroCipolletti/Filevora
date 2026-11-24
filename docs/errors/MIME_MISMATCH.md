# MIME_MISMATCH

The declared file type does not match the sniffed bytes.

Category: `upload`. HTTP 415. Retryable: false.

The upload declared a MIME type that contradicts the byte signature.

- resend: Upload the file with a declared type that matches its contents.
