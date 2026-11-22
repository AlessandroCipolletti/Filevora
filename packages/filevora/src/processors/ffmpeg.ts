import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fail } from '../errors/error.js';
import { createId, nowIso, sha256, tenantPath } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { redactString } from '../redact.js';
import { writeBytes } from '../storage/filesystem.js';

/** Use FFmpeg libwebp only when that encoder is listed. Otherwise Sharp encodes the poster. */
export function selectPosterEncoder(encoderList: string): 'libwebp' | 'sharp' {
  return /(^|\s)libwebp(\s|$)/m.test(encoderList) ? 'libwebp' : 'sharp';
}

/** stdout and stderr of `ffmpeg -encoders`, or an empty string when the binary is missing. */
export function probeFfmpegEncoders(ffmpeg = 'ffmpeg'): string {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
  });
  if (result.error) return '';
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

export interface ProbeInfo {
  durationMs: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  audioCodec?: string;
}

export interface MediaTransform {
  kind: 'video.trim' | 'video.transcode' | 'audio.transcode';
  startSeconds?: number;
  endSeconds?: number;
  maxHeight?: number;
  codec?: 'aac' | 'mp3' | 'opus';
}

interface MediaFile {
  id: string;
  tenant_id: string;
  detected_mime: string | null;
  original_object_key: string | null;
}

/**
 * `out_time_ms` from FFmpeg progress is microseconds. Returns 0..1 when duration is known.
 */
export function progressRatio(
  line: string,
  durationMs: number,
): number | undefined {
  const match = /out_time_(?:us|ms)=(\d+)/.exec(line);
  const raw = match?.[1];
  if (!raw || durationMs <= 0) return undefined;
  return Math.max(0, Math.min(1, Number(raw) / 1000 / durationMs));
}

export function assertRecipe(transforms: MediaTransform[]): void {
  for (const transform of transforms) {
    if (transform.kind === 'video.trim') {
      if (
        !Number.isFinite(transform.startSeconds) ||
        !Number.isFinite(transform.endSeconds)
      ) {
        throw fail('INVALID_RECIPE', {
          message: 'Trim times must be finite numbers.',
        });
      }
      if (
        (transform.startSeconds ?? 0) < 0 ||
        (transform.endSeconds ?? 0) <= (transform.startSeconds ?? 0)
      ) {
        throw fail('INVALID_RECIPE', {
          message: 'Trim end must be after the start.',
        });
      }
    } else if (transform.kind === 'video.transcode') {
      if (
        !Number.isInteger(transform.maxHeight) ||
        (transform.maxHeight ?? 0) < 16 ||
        (transform.maxHeight ?? 0) > 1080
      ) {
        throw fail('INVALID_RECIPE', {
          message: 'Transcode height must be an integer from 16 to 1080.',
        });
      }
    } else if (transform.kind === 'audio.transcode') {
      if (
        transform.codec !== 'aac' &&
        transform.codec !== 'mp3' &&
        transform.codec !== 'opus'
      ) {
        throw fail('INVALID_RECIPE', {
          message: 'Audio codec must be aac, mp3, or opus.',
        });
      }
    } else {
      throw fail('INVALID_RECIPE', {
        message: 'The processing recipe is not allowed.',
      });
    }
  }
}

export async function probeMedia(
  ffprobe: string,
  file: string,
  timeoutMs: number,
): Promise<ProbeInfo> {
  const stdout = await runCapture(
    ffprobe,
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      file,
    ],
    timeoutMs,
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: ProbeStream[];
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const durationSec = Number(
    parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0,
  );
  return {
    durationMs: Number.isFinite(durationSec)
      ? Math.round(durationSec * 1000)
      : 0,
    ...(video?.width ? { width: video.width } : {}),
    ...(video?.height ? { height: video.height } : {}),
    ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
  };
}

export async function runFfmpeg(
  ffmpeg: string,
  args: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    durationMs?: number;
    onPid?: (pid: number) => void;
    onProgress?: (ratio: number) => void;
  },
): Promise<void> {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0'))
      throw fail('INVALID_RECIPE');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) options.onPid?.(child.pid);
    let stderr = '';
    let stdout = '';
    let settled = false;
    const stop = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      stop(fail('PROCESSING_TIMEOUT'));
    }, options.timeoutMs);
    options.signal?.addEventListener('abort', () => {
      child.kill('SIGKILL');
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const ratio = progressRatio(line, options.durationMs ?? 0);
        if (ratio !== undefined) options.onProgress?.(ratio);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(fail('FFMPEG_NOT_FOUND'));
      else
        reject(fail('FFMPEG_FAILED', { message: redactString(error.message) }));
    });
    child.on('close', (code) => {
      if (options.signal?.aborted) stop(fail('CANCELLED'));
      else if (code === 0) stop();
      else
        stop(
          fail('FFMPEG_FAILED', {
            message: redactString(
              stderr || `FFmpeg exited ${code ?? 'unknown'}.`,
            ),
          }),
        );
    });
  });
}

export async function publishVideoPreset(
  sql: Sql,
  root: string,
  file: MediaFile,
  paths: { ffmpeg: string; ffprobe: string },
  limits: { timeoutMs: number; maxDurationSeconds: number; maxHeight: number },
  hooks: { jobId: string; signal?: AbortSignal },
): Promise<string[]> {
  return publishMedia(sql, root, file, paths, limits, hooks, 'video');
}

export async function publishAudioPreset(
  sql: Sql,
  root: string,
  file: MediaFile,
  paths: { ffmpeg: string; ffprobe: string },
  limits: { timeoutMs: number; maxDurationSeconds: number },
  hooks: { jobId: string; signal?: AbortSignal },
): Promise<string[]> {
  return publishMedia(
    sql,
    root,
    file,
    paths,
    { ...limits, maxHeight: 0 },
    hooks,
    'audio',
  );
}

export async function publishRecipe(
  sql: Sql,
  root: string,
  file: MediaFile,
  transforms: MediaTransform[],
  paths: { ffmpeg: string; ffprobe: string },
  limits: { timeoutMs: number; maxDurationSeconds: number },
  hooks: { jobId: string; signal?: AbortSignal },
): Promise<string[]> {
  assertRecipe(transforms);
  if (!file.original_object_key) throw fail('NOT_FOUND');
  const input = path.join(root, file.original_object_key);
  const probe = await probeMedia(paths.ffprobe, input, limits.timeoutMs);
  if (probe.durationMs > limits.maxDurationSeconds * 1000) {
    throw fail('INVALID_RECIPE', {
      message: 'The media is longer than the configured maximum.',
    });
  }
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-recipe-'));
  try {
    let current = input;
    let index = 0;
    for (const transform of transforms) {
      const next = path.join(work, `step-${index}`);
      index += 1;
      if (transform.kind === 'video.trim') {
        await runFfmpeg(
          paths.ffmpeg,
          [
            '-y',
            '-i',
            current,
            '-ss',
            String(transform.startSeconds),
            '-to',
            String(transform.endSeconds),
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '28',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            '-progress',
            'pipe:1',
            '-nostats',
            `${next}.mp4`,
          ],
          {
            timeoutMs: limits.timeoutMs,
            signal: hooks.signal,
            durationMs: probe.durationMs,
            onPid: (pid) => setRunner(sql, hooks.jobId, pid),
          },
        );
        current = `${next}.mp4`;
      } else if (transform.kind === 'video.transcode') {
        const height = transform.maxHeight ?? 720;
        await runFfmpeg(
          paths.ffmpeg,
          [
            '-y',
            '-i',
            current,
            '-vf',
            `scale=-2:'min(${height},ih)'`,
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '28',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            '-progress',
            'pipe:1',
            '-nostats',
            `${next}.mp4`,
          ],
          {
            timeoutMs: limits.timeoutMs,
            signal: hooks.signal,
            durationMs: probe.durationMs,
            onPid: (pid) => setRunner(sql, hooks.jobId, pid),
          },
        );
        current = `${next}.mp4`;
      } else {
        const encoded = await encodeAudio(
          paths.ffmpeg,
          current,
          next,
          transform.codec ?? 'aac',
          limits.timeoutMs,
          hooks,
          probe.durationMs,
          sql,
        );
        current = encoded;
      }
    }
    const body = readFileSync(current);
    const probed = await probeMedia(paths.ffprobe, current, limits.timeoutMs);
    const name = 'custom';
    await storeVariant(sql, root, file, {
      name,
      recipeId: 'recipe',
      body,
      mime: current.endsWith('.mp3')
        ? 'audio/mpeg'
        : current.endsWith('.ogg')
          ? 'audio/ogg'
          : current.endsWith('.m4a')
            ? 'audio/mp4'
            : 'video/mp4',
      extension: path.extname(current).slice(1) || 'bin',
      width: probed.width,
      height: probed.height,
      durationMs: probed.durationMs,
    });
    sql.run(
      `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
      [nowIso(), file.id],
    );
    return [name];
  } finally {
    setRunner(sql, hooks.jobId, null);
    rmSync(work, { recursive: true, force: true });
  }
}

async function publishMedia(
  sql: Sql,
  root: string,
  file: MediaFile,
  paths: { ffmpeg: string; ffprobe: string },
  limits: { timeoutMs: number; maxDurationSeconds: number; maxHeight: number },
  hooks: { jobId: string; signal?: AbortSignal },
  kind: 'video' | 'audio',
): Promise<string[]> {
  if (!file.original_object_key) throw fail('NOT_FOUND');
  const input = path.join(root, file.original_object_key);
  const probe = await probeMedia(paths.ffprobe, input, limits.timeoutMs);
  if (probe.durationMs > limits.maxDurationSeconds * 1000) {
    throw fail('INVALID_RECIPE', {
      message: 'The media is longer than the configured maximum.',
    });
  }
  const work = mkdtempSync(path.join(tmpdir(), 'filevora-media-'));
  const names: string[] = [];
  try {
    if (kind === 'audio') {
      const output = await encodeAudio(
        paths.ffmpeg,
        input,
        path.join(work, 'optimized'),
        'aac',
        limits.timeoutMs,
        hooks,
        probe.durationMs,
        sql,
      );
      const body = readFileSync(output);
      const probed = await probeMedia(paths.ffprobe, output, limits.timeoutMs);
      await storeVariant(sql, root, file, {
        name: 'optimized',
        recipeId: 'web-optimized',
        body,
        mime: 'audio/mp4',
        extension: 'm4a',
        durationMs: probed.durationMs,
      });
      names.push('optimized');
    } else {
      const posterEncoder = selectPosterEncoder(
        probeFfmpegEncoders(paths.ffmpeg),
      );
      const sharp = (await import('sharp')).default;
      let poster: Buffer;
      if (posterEncoder === 'libwebp') {
        const posterWebp = path.join(work, 'poster.webp');
        await runFfmpeg(
          paths.ffmpeg,
          [
            '-y',
            '-ss',
            '0',
            '-i',
            input,
            '-frames:v',
            '1',
            '-c:v',
            'libwebp',
            posterWebp,
          ],
          {
            timeoutMs: limits.timeoutMs,
            signal: hooks.signal,
            onPid: (pid) => setRunner(sql, hooks.jobId, pid),
          },
        );
        poster = readFileSync(posterWebp);
      } else {
        const posterPng = path.join(work, 'poster.png');
        await runFfmpeg(
          paths.ffmpeg,
          ['-y', '-ss', '0', '-i', input, '-frames:v', '1', posterPng],
          {
            timeoutMs: limits.timeoutMs,
            signal: hooks.signal,
            onPid: (pid) => setRunner(sql, hooks.jobId, pid),
          },
        );
        poster = await sharp(posterPng)
          .rotate()
          .resize({ width: 320, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
      }
      const posterInfo = await sharp(poster).metadata();
      await storeVariant(sql, root, file, {
        name: 'thumbnail',
        recipeId: 'web-optimized',
        body: poster,
        mime: 'image/webp',
        extension: 'webp',
        width: posterInfo.width,
        height: posterInfo.height,
      });
      names.push('thumbnail');
      const optimized = path.join(work, 'optimized.mp4');
      await runFfmpeg(
        paths.ffmpeg,
        [
          '-y',
          '-i',
          input,
          '-vf',
          "scale=-2:'min(720,ih)'",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          '-progress',
          'pipe:1',
          '-nostats',
          optimized,
        ],
        {
          timeoutMs: limits.timeoutMs,
          signal: hooks.signal,
          durationMs: probe.durationMs,
          onPid: (pid) => setRunner(sql, hooks.jobId, pid),
        },
      );
      const optimizedProbe = await probeMedia(
        paths.ffprobe,
        optimized,
        limits.timeoutMs,
      );
      await storeVariant(sql, root, file, {
        name: 'optimized',
        recipeId: 'web-optimized',
        body: readFileSync(optimized),
        mime: 'video/mp4',
        extension: 'mp4',
        width: optimizedProbe.width,
        height: optimizedProbe.height,
        durationMs: optimizedProbe.durationMs,
      });
      names.push('optimized');
      if ((probe.height ?? 0) > 720 && limits.maxHeight >= 1080) {
        const hd = path.join(work, 'hd.mp4');
        await runFfmpeg(
          paths.ffmpeg,
          [
            '-y',
            '-i',
            input,
            '-vf',
            "scale=-2:'min(1080,ih)'",
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '28',
            '-c:a',
            'aac',
            '-movflags',
            '+faststart',
            '-progress',
            'pipe:1',
            '-nostats',
            hd,
          ],
          {
            timeoutMs: limits.timeoutMs,
            signal: hooks.signal,
            durationMs: probe.durationMs,
            onPid: (pid) => setRunner(sql, hooks.jobId, pid),
          },
        );
        const hdProbe = await probeMedia(paths.ffprobe, hd, limits.timeoutMs);
        await storeVariant(sql, root, file, {
          name: 'hd',
          recipeId: 'web-optimized',
          body: readFileSync(hd),
          mime: 'video/mp4',
          extension: 'mp4',
          width: hdProbe.width,
          height: hdProbe.height,
          durationMs: hdProbe.durationMs,
        });
        names.push('hd');
      }
    }
    sql.run(
      `UPDATE files SET processing_state = 'ready', updated_at = ? WHERE id = ?`,
      [nowIso(), file.id],
    );
    return names;
  } finally {
    setRunner(sql, hooks.jobId, null);
    rmSync(work, { recursive: true, force: true });
  }
}

async function encodeAudio(
  ffmpeg: string,
  input: string,
  stem: string,
  codec: 'aac' | 'mp3' | 'opus',
  timeoutMs: number,
  hooks: { jobId: string; signal?: AbortSignal },
  durationMs: number,
  sql: Sql,
): Promise<string> {
  if (codec === 'mp3') {
    const output = `${stem}.mp3`;
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-i',
        input,
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-progress',
        'pipe:1',
        '-nostats',
        output,
      ],
      {
        timeoutMs,
        signal: hooks.signal,
        durationMs,
        onPid: (pid) => setRunner(sql, hooks.jobId, pid),
      },
    );
    return output;
  }
  if (codec === 'opus') {
    const output = `${stem}.ogg`;
    await runFfmpeg(
      ffmpeg,
      [
        '-y',
        '-i',
        input,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-progress',
        'pipe:1',
        '-nostats',
        output,
      ],
      {
        timeoutMs,
        signal: hooks.signal,
        durationMs,
        onPid: (pid) => setRunner(sql, hooks.jobId, pid),
      },
    );
    return output;
  }
  const output = `${stem}.m4a`;
  await runFfmpeg(
    ffmpeg,
    [
      '-y',
      '-i',
      input,
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-progress',
      'pipe:1',
      '-nostats',
      output,
    ],
    {
      timeoutMs,
      signal: hooks.signal,
      durationMs,
      onPid: (pid) => setRunner(sql, hooks.jobId, pid),
    },
  );
  return output;
}

function setRunner(sql: Sql, jobId: string, pid: number | null): void {
  sql.run('UPDATE jobs SET runner_pid = ? WHERE id = ?', [pid, jobId]);
}

async function storeVariant(
  sql: Sql,
  root: string,
  file: MediaFile,
  input: {
    name: string;
    recipeId: string;
    body: Uint8Array;
    mime: string;
    extension: string;
    width?: number;
    height?: number;
    durationMs?: number;
  },
): Promise<void> {
  const existing = sql.get<{ id: string }>(
    'SELECT id FROM variants WHERE file_id = ? AND name = ? AND recipe_id = ? AND recipe_version = 1',
    [file.id, input.name, input.recipeId],
  );
  if (existing) return;
  const id = createId('variant');
  const key = `${tenantPath(file.tenant_id)}/files/${file.id}/variants/${id}/${input.name}.${input.extension}`;
  await writeBytes(root, key, input.body);
  sql.run(
    `INSERT INTO variants (
      id, file_id, name, recipe_id, recipe_version, storage_key, mime, bytes, width, height, duration_ms, checksum, status, created_at
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'ready', ?)`,
    [
      id,
      file.id,
      input.name,
      input.recipeId,
      key,
      input.mime,
      input.body.byteLength,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      sha256(input.body),
      nowIso(),
    ],
  );
}

async function runCapture(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(fail('PROCESSING_TIMEOUT'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-1000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') reject(fail('FFMPEG_NOT_FOUND'));
      else
        reject(fail('FFMPEG_FAILED', { message: redactString(error.message) }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          fail('FFMPEG_FAILED', {
            message: redactString(
              stderr || `Probe exited ${code ?? 'unknown'}.`,
            ),
          }),
        );
    });
  });
}
