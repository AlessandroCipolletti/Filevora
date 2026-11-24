# DESCRIPTION_NOT_CONFIGURED

A description cannot be created without a Gemini API key.

Category: `config`. HTTP 422. Retryable: false.

Filevora sends a smaller copy of the asset to Google Gemini only when `FILEVORA_GEMINI_API_KEY` is set. The asset upload still succeeds when the description is skipped by default. An explicit `describe: true` without a key returns this error.

- set_gemini_key: Set `FILEVORA_GEMINI_API_KEY` to a Google AI Studio key, then retry the description. `export FILEVORA_GEMINI_API_KEY=your-key`
