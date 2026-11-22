# PROCESSOR_UNAVAILABLE

The processor dependency is not installed.

Category: `processing`. HTTP 501. Retryable: false.

An optional processor such as sharp could not be loaded. Core upload still works without it.

- install_processor: Install the optional dependency named in the error context.

Verify: `npx filevora doctor --json`
