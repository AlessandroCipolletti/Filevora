# Measured baseline

darwin, Node v26.5.0, 22 November 2026. The operation is `test/m11.test.ts`: one 1×1 PNG fixture turned into three WebP variants, including the in-process worker claim.

- Isolated run: `benchmark_image_ms=46`
- Full-suite run immediately after: `benchmark_image_ms=81`

This is not a throughput, memory, or multi-size benchmark.
