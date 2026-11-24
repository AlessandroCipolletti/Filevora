# FFMPEG_NOT_FOUND

Video processing requires an FFmpeg executable.

Category: `processing`. HTTP 501. Retryable: false.

The configured FFmpeg or ffprobe path is not an executable. Filevora does not download binaries.

- install_ffmpeg: Install FFmpeg and ffprobe for the operating system.
- set_path: Set FILES_FFMPEG_PATH and FILES_FFPROBE_PATH to the executables.

Verify: `npx filevora doctor --json`
