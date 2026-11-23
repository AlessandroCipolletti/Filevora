# Measured baseline

darwin, Node v26.5.0, 22 November 2026. The operation is `test/m11.test.ts`: one 1×1 PNG fixture turned into three WebP variants, including the in-process worker claim.

- Isolated run: `benchmark_image_ms=46`
- Full-suite run immediately after: `benchmark_image_ms=81`

23 November 2026, same machine and the same 1×1 PNG fixture, after the PDF preview and poster-encoder tests were added:

- Full suite: `benchmark_image_ms=88`
- A later full suite: `benchmark_image_ms=107`

23 November 2026, after the JavaScript emit moved to Vite library mode, one full suite printed `benchmark_image_ms=156` for the same 1×1 PNG fixture.

This is not a throughput, memory, or multi-size benchmark.
