# Security

Filevora accepts attacker-controlled bytes once upload routes exist. This file records the rules for this repository. Upload handling is not implemented yet; the rules still apply to the configuration and error paths that exist now.

Report vulnerabilities through a private GitHub security advisory on [AlessandroCipolletti/Filevora](https://github.com/AlessandroCipolletti/Filevora). Do not open a public issue for an unfixed vulnerability.

## Boundaries

- The host application authenticates users. Filevora does not create accounts or API keys.
- `authenticate` and `authorize` are required to construct the HTTP handler. There is no default allow.
- Tenant and owner ids used for authorization come from the host principal, not from the request body.
- Browser code must not receive S3 secret keys, the signing secret, database URLs, or a future managed API key.
- Managed cloud configuration keys are reserved. Setting the provider to `managed` or `hybrid` fails. Leaving the keys unset is the normal path.
- Error JSON does not include stack traces. Context objects pass through secret redaction.
- Production filesystem or SQLite deployments must set an explicit single-host acknowledgement. Production storage under the OS temp directory is rejected.
- Serverless and edge runtimes cannot auto-spawn a worker.

## Not claimed yet

Checksum verification, MIME sniffing, path confinement, signed download tokens, webhook signatures, and process isolation are specified and will be tested in the milestone that implements them. They are not current behavior.
