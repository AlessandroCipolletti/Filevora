/** Pure timing and sprite-map helpers. FFmpeg and Sharp stay in the publisher. */

export function frameOffsetMs(input: {
  durationMs: number;
  atMs?: number;
  atPercent?: number;
}): number {
  const duration = Math.max(0, input.durationMs);
  const raw =
    input.atPercent !== undefined
      ? Math.round((duration * clampPercent(input.atPercent)) / 100)
      : (input.atMs ?? 0);
  if (duration <= 0) return 0;
  const margin = Math.min(250, Math.floor(duration / 2));
  return Math.min(raw, Math.max(0, duration - margin));
}

export function thumbnailTimes(input: {
  durationMs: number;
  count?: number;
  intervalMs?: number;
  atMs?: number[];
  atPercent?: number[];
}): number[] {
  const duration = Math.max(0, input.durationMs);
  if (input.atMs && input.atMs.length > 0) {
    return input.atMs.map((atMs) =>
      frameOffsetMs({ durationMs: duration, atMs }),
    );
  }
  if (input.atPercent && input.atPercent.length > 0) {
    return input.atPercent.map((atPercent) =>
      frameOffsetMs({ durationMs: duration, atPercent }),
    );
  }
  const count = Math.min(48, Math.max(1, input.count ?? 1));
  if (input.intervalMs && input.intervalMs > 0) {
    const times: number[] = [];
    for (
      let at = 0;
      times.length < count && (duration <= 0 || at < duration);
      at += input.intervalMs
    ) {
      times.push(frameOffsetMs({ durationMs: duration, atMs: at }));
      if (duration <= 0) break;
    }
    return times.length > 0 ? times : [0];
  }
  if (count === 1 || duration <= 0) return [0];
  const step = duration / count;
  return Array.from({ length: count }, (_, index) =>
    frameOffsetMs({
      durationMs: duration,
      atMs: Math.round(step * index + step / 2),
    }),
  );
}

export interface SpriteFrame {
  startMs: number;
  endMs: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function spriteTimeline(input: {
  timesMs: number[];
  columns: number;
  cellWidth: number;
  cellHeight: number;
  image: string;
}): { vtt: string; json: string; frames: SpriteFrame[] } {
  const columns = Math.max(1, input.columns);
  const frames: SpriteFrame[] = input.timesMs.map((startMs, index) => {
    const next = input.timesMs[index + 1];
    const endMs = next !== undefined && next > startMs ? next : startMs + 1000;
    return {
      startMs,
      endMs,
      x: (index % columns) * input.cellWidth,
      y: Math.floor(index / columns) * input.cellHeight,
      w: input.cellWidth,
      h: input.cellHeight,
    };
  });
  const cues = frames
    .map(
      (frame) =>
        `${vttClock(frame.startMs)} --> ${vttClock(frame.endMs)}\n${input.image}#xywh=${frame.x},${frame.y},${frame.w},${frame.h}`,
    )
    .join('\n\n');
  const vtt = `WEBVTT\n\n${cues}\n`;
  const json = JSON.stringify({
    image: input.image,
    columns,
    cellWidth: input.cellWidth,
    cellHeight: input.cellHeight,
    frames,
  });
  return { vtt, json, frames };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function vttClock(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (value: number, size: number) =>
    String(value).padStart(size, '0');
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}`;
}
