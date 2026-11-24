import { readFileSync } from 'node:fs';
import { probeMedia, runFfmpeg } from './ffmpeg.js';

export interface WavePeak {
  min: number;
  max: number;
}

/** Downsample mono float samples into min/max peaks. */
export function peaksFromPcm(
  samples: Float32Array,
  buckets: number,
): WavePeak[] {
  const count = Math.max(1, Math.min(buckets, samples.length || 1));
  const peaks: WavePeak[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * samples.length) / count);
    const end = Math.max(
      start + 1,
      Math.floor(((index + 1) * samples.length) / count),
    );
    let min = 0;
    let max = 0;
    for (
      let cursor = start;
      cursor < end && cursor < samples.length;
      cursor += 1
    ) {
      const value = samples[cursor] ?? 0;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    peaks.push({
      min: Math.round(min * 1000) / 1000,
      max: Math.round(max * 1000) / 1000,
    });
  }
  return peaks;
}

export function readPcmPeaks(file: string, buckets: number): WavePeak[] {
  const raw = readFileSync(file);
  const samples = new Float32Array(
    raw.buffer,
    raw.byteOffset,
    Math.floor(raw.byteLength / 4),
  );
  return peaksFromPcm(samples, buckets);
}

/** EBU R128 target used by ffmpeg loudnorm: -23 LUFS, -1.5 dBTP, LRA 11. */
export const LOUDNORM_FILTER =
  'loudnorm=I=-23:TP=-1.5:LRA=11:print_format=summary';

export async function describeAudioFile(
  ffprobe: string,
  file: string,
  timeoutMs: number,
) {
  const probe = await probeMedia(ffprobe, file, timeoutMs);
  return {
    durationMs: probe.durationMs,
    audioCodec: probe.audioCodec ?? null,
    sampleRate: probe.sampleRate ?? null,
    channels: probe.channels ?? null,
    bitRate: probe.bitRate ?? null,
  };
}

export async function transcodeAudio(input: {
  ffmpeg: string;
  source: string;
  output: string;
  format: 'mp3' | 'aac' | 'ogg' | 'wav';
  bitrateKbps?: number;
  timeoutMs: number;
  loudnorm?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const bitrate = `${input.bitrateKbps ?? 128}k`;
  const args = ['-y', '-i', input.source];
  if (input.loudnorm) args.push('-af', LOUDNORM_FILTER);
  if (input.format === 'mp3') {
    args.push('-c:a', 'libmp3lame', '-b:a', bitrate);
  } else if (input.format === 'aac') {
    args.push('-c:a', 'aac', '-b:a', bitrate);
  } else if (input.format === 'ogg') {
    args.push('-c:a', 'libopus', '-b:a', bitrate);
  } else {
    args.push('-c:a', 'pcm_s16le');
  }
  args.push('-vn', input.output);
  await runFfmpeg(input.ffmpeg, args, {
    timeoutMs: input.timeoutMs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function renderWaveformImage(input: {
  ffmpeg: string;
  source: string;
  output: string;
  width: number;
  height: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  await runFfmpeg(
    input.ffmpeg,
    [
      '-y',
      '-i',
      input.source,
      '-filter_complex',
      `aformat=channel_layouts=mono,showwavespic=s=${input.width}x${input.height}:colors=0x1f6feb`,
      '-frames:v',
      '1',
      input.output,
    ],
    {
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
}

export async function renderWaveformPcm(input: {
  ffmpeg: string;
  source: string;
  output: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  await runFfmpeg(
    input.ffmpeg,
    [
      '-y',
      '-i',
      input.source,
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      'f32le',
      input.output,
    ],
    {
      timeoutMs: input.timeoutMs,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
}
