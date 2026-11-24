# ADR 0006: FFmpeg distribution

## Status

Accepted

## Problem

Video and audio need FFmpeg. Shipping binaries creates license and supply-chain risk.

## Constraints

No download on install or import. Argument arrays only. The host binary's codec set is whatever the user installed.

## Options

1. System `ffmpeg` and `ffprobe`, overridable with `FILES_FFMPEG_PATH` and `FILES_FFPROBE_PATH`.
2. Download a pinned build in `postinstall`.
3. Require Docker for every video test.

## Decision

Option 1. Doctor reports the version and whether the needed encoders exist. Missing binaries fail the job with `FFMPEG_NOT_FOUND` and do not fail unrelated image or file uploads. A Dockerfile recipe documents a known build. GPL versus LGPL depends on that build; the npm package does not include FFmpeg.

## Rejected alternatives

Silent downloads surprise operators and hide the codec license.

## Security and reliability

Spawn with `shell: false`. Timeouts kill the process. Stderr is truncated and redacted before it is stored.

## Migration

Set the path variables when the binary is not on `PATH`.

## Tests

M5 on a machine where `ffmpeg` and `ffprobe` exist. The capability manifest records the version that was actually probed.
