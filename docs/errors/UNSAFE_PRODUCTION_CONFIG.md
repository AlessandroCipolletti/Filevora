# UNSAFE_PRODUCTION_CONFIG

Production configuration is missing an explicit durability acknowledgement or uses ephemeral storage.

Category: `config`. HTTP 500. Retryable: false.

Production must name its storage and metadata drivers. Single-host SQLite or filesystem storage must set FILES_SINGLE_HOST_ACK=true. Storage roots under the OS temp directory are rejected.

- ack_storage: Point storage at a persistent disk or set an explicit single-host acknowledgement.

Verify: `npx filevora config validate --json`
