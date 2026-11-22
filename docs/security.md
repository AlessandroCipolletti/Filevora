# Security model

This is the design the code is required to follow. Items marked current are enforced by tests today.

Current:

- No default-open HTTP handler. `authenticate`, `authorize`, and `policy` are required.
- Managed credentials and cloud mode cannot be selected.
- Error payloads redact secret-like keys and credential patterns and omit stacks.
- Production refuses unacknowledged local durability and temp-dir object roots.
- The browser entry is built without Node modules.

Required before the feature is called done:

- Sniffed MIME and byte length, not the client's filename.
- Opaque object keys inside a resolved root. No symlink escape.
- Signed, short-lived delivery tokens. S3 URLs are presigned and cannot be revoked before expiry; filesystem tokens are checked against deletion.
- FFmpeg receives an argument array built from an allowlist. No shell.
- Webhooks use HMAC and reject private targets in production.
- Optional AI diagnostics receive a redacted report and cannot change error codes.

Threat review for the implemented attack surface is updated in M11.
