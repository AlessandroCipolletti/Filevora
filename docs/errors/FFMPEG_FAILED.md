# FFMPEG_FAILED

FFmpeg failed while processing media.

Category: `processing`. HTTP 422. Retryable: false.

The spawned FFmpeg process exited with an error. Arguments come from the validated recipe, not from the user.

- inspect_media: Probe the original with ffprobe. Reject corrupt or unsupported codecs.

Verify: `npx filevora doctor --json`
