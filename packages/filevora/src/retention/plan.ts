export interface RetentionInput {
  enabled: boolean;
  maxAgeDays: number | null;
  unusedAfterDays: number | null;
  gracePeriodDays: number;
}

export interface RetentionCandidate {
  fileId: string;
  bytes: number;
  reason: 'max-age' | 'unused' | 'grace-elapsed';
  pinned: boolean;
}

export interface RetentionRow {
  id: string;
  bytes: number;
  pinned: number;
  created_at: string;
  deleted_at: string | null;
  grace_until: string | null;
  last_touch_at: string | null;
  original_object_key: string | null;
}

/** Decide which files a sweep may delete. Pins and missing inactivity evidence are skipped. */
export function planRetention(
  rows: RetentionRow[],
  policy: RetentionInput,
  nowMs: number,
): RetentionCandidate[] {
  if (!policy.enabled) return [];
  const items: RetentionCandidate[] = [];
  for (const row of rows) {
    if (row.pinned) continue;
    if (
      row.deleted_at &&
      row.grace_until &&
      Date.parse(row.grace_until) <= nowMs
    ) {
      items.push({
        fileId: row.id,
        bytes: row.bytes,
        reason: 'grace-elapsed',
        pinned: false,
      });
      continue;
    }
    if (row.deleted_at) continue;
    if (
      policy.maxAgeDays &&
      Date.parse(row.created_at) + policy.maxAgeDays * 86_400_000 <= nowMs
    ) {
      items.push({
        fileId: row.id,
        bytes: row.bytes,
        reason: 'max-age',
        pinned: false,
      });
      continue;
    }
    if (
      policy.unusedAfterDays &&
      row.last_touch_at &&
      Date.parse(row.last_touch_at) + policy.unusedAfterDays * 86_400_000 <=
        nowMs
    ) {
      items.push({
        fileId: row.id,
        bytes: row.bytes,
        reason: 'unused',
        pinned: false,
      });
    }
  }
  return items;
}
