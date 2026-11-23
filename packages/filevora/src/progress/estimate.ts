/** Remaining time from a monotonic ratio. Null until the ratio is usable. */
export function estimateRemainingMs(
  startedAtMs: number,
  ratio: number,
  nowMs: number,
): number | null {
  if (!(ratio > 0.02 && ratio < 1)) return null;
  const elapsed = nowMs - startedAtMs;
  if (elapsed < 200) return null;
  return Math.round((elapsed * (1 - ratio)) / ratio);
}

/** Images and other short jobs stay quiet. Video and audio emit a ratio. */
export function streamsDetailedProgress(
  mime: string | null | undefined,
): boolean {
  if (!mime) return false;
  return mime.startsWith('video/') || mime.startsWith('audio/');
}
