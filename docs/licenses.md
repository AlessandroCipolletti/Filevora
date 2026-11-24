# Licenses

The published package `filevora` is MIT. Copyright 2026 Alessandro Cipolletti. See `LICENSE`.

Runtime dependencies in the package:

- `zod` and `exceljs` are installed with the package.
- `sharp`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, and `pg` are optional. A filesystem install can run without the AWS SDK. Image variants need `sharp`. Networked Postgres tests need `pg`.

Programs this package does not ship:

- FFmpeg and ffprobe come from the host. The local verification machine used FFmpeg 8.1.2, which has libx264 and AAC and has no libwebp encoder.
- PDF page images use Poppler's `pdftoppm` from the host (`pdf.pages`, `pdf-pages`, `pdf-cover`, and the normalize preview). The local machine used pdftoppm 26.04.0. Text extraction does not require it.

No SBOM file is generated in this repository. `npm pack --dry-run` is the release contents check, and the resulting tarball is deleted.
