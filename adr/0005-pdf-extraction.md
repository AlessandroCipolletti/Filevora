# ADR 0005: PDF extraction

## Status

Accepted

## Problem

The SDK needs honest PDF text extraction without inventing OCR text.

## Constraints

No mandatory native canvas. Encrypted PDFs fail clearly. OCR is optional.

## Options

1. `pdfjs-dist` for text and page count. Table extraction only when a fixture proves a simple layout. No raster page preview until a test produces an image. OCR is an interface that returns `OCR_NOT_CONFIGURED`.
2. Bundle Poppler or MuPDF.
3. Send PDFs to a hosted model.

## Decision

Option 1. Page raster previews stay unsupported until a test writes an image and the capability manifest says `tested`. Scanned PDFs return an empty text layer and `OCR_NOT_CONFIGURED` instead of guessed text.

## Rejected alternatives

Bundling a PDF renderer adds native and license surface. A model call would fabricate text and upload customer bytes.

## Security and reliability

Limits on byte size and page count. Encrypted files do not fall through to an empty success that looks like a normal document.

## Migration

An OCR adapter can be registered later without changing the extract result shape.

## Tests

M8 fixtures: text PDF, encrypted PDF, image-only PDF, and a simple table fixture if the extractor actually returns those cells.
