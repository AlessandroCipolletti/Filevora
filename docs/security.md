# Security model

This is the design the code is required to follow. Items marked current are enforced by tests today.

Current:

- No default-open HTTP handler. `authenticate`, `authorize`, and `policy` are required.
- Managed credentials and cloud mode cannot be selected.
- Error payloads redact secret-like keys and credential patterns and omit stacks.
- Production refuses unacknowledged local durability and temp-dir object roots.
- The browser entry is built without Node modules.
- Private assets are not served from a bare storage path. Downloads use an HMAC `/content` token or, on S3, a presigned URL. Public assets use `/public` and a missing asset card stays private. See [access-control.md](access-control.md).

Tested in this repository:

- Sniffed bytes reject a declared PNG that is not a PNG.
- Object keys reject `..`. Filesystem delivery tokens stop working after deletion. S3 presigned URLs in the emulator test did not contain the secret.
- FFmpeg is spawned with `shell: false` and an allowlisted recipe. Abort and timeout kill the process.
- Webhook HMAC verification rejects an old timestamp, and private or loopback targets are rejected when loopback is not allowed.
- The optional explainer receives a redacted report and cannot replace the error code.

Not tested here: symlink races, a live S3 bucket, malware scanning, and a networked Postgres server. The package was not published.
