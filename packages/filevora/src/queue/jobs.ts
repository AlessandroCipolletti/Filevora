import { createId, nowIso } from '../ids.js';
import type { Sql } from '../metadata/sqlite.js';
import { JOB_SCHEMA_VERSION } from '../version.js';

export interface JobRow {
  id: string;
  file_id: string;
  tenant_id: string;
  type: string;
  payload_json: string;
  schema_version: number;
  state: string;
  attempts: number;
  max_attempts: number;
  run_after: string;
  lease_owner: string | null;
  lease_until: string | null;
  idempotency_key: string | null;
  error_code: string | null;
  error_message: string | null;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function insertJob(
  sql: Sql,
  input: {
    fileId: string;
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
    maxAttempts: number;
    idempotencyKey: string;
  },
): JobRow {
  const existing = sql.get<JobRow>(
    'SELECT * FROM jobs WHERE tenant_id = ? AND idempotency_key = ?',
    [input.tenantId, input.idempotencyKey],
  );
  if (existing) return existing;
  const now = nowIso();
  const id = createId('job');
  sql.run(
    `INSERT INTO jobs (
      id, file_id, tenant_id, type, payload_json, schema_version, state, attempts, max_attempts,
      run_after, idempotency_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
    [
      id,
      input.fileId,
      input.tenantId,
      input.type,
      JSON.stringify(input.payload),
      JOB_SCHEMA_VERSION,
      input.maxAttempts,
      now,
      input.idempotencyKey,
      now,
      now,
    ],
  );
  const created = sql.get<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
  if (!created) throw new Error('The job was not stored.');
  return created;
}

/** Claim one due job. Stale processing leases can be taken again. */
export function claimJob(
  sql: Sql,
  owner: string,
  leaseSeconds: number,
): JobRow | undefined {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return sql.transaction(() => {
    const row = sql.get<JobRow>(
      `SELECT * FROM jobs
       WHERE run_after <= ?
         AND (
           state IN ('queued', 'retrying')
           OR (state = 'processing' AND (lease_until IS NULL OR lease_until <= ?))
         )
       ORDER BY run_after ASC, id ASC
       LIMIT 1`,
      [now, now],
    );
    if (!row) return undefined;
    if (row.attempts >= row.max_attempts) {
      sql.run(
        `UPDATE jobs SET state = 'dead', updated_at = ?, finished_at = ? WHERE id = ?`,
        [now, now, row.id],
      );
      return undefined;
    }
    sql.run(
      `UPDATE jobs
       SET state = 'processing', lease_owner = ?, lease_until = ?, attempts = attempts + 1,
           started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ?`,
      [owner, leaseUntil, now, now, row.id],
    );
    return sql.get<JobRow>(
      'SELECT * FROM jobs WHERE id = ? AND lease_owner = ?',
      [row.id, owner],
    );
  });
}

export function heartbeatJob(
  sql: Sql,
  jobId: string,
  owner: string,
  leaseSeconds: number,
): void {
  const now = nowIso();
  const leaseUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  sql.run(
    `UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND state = 'processing'`,
    [leaseUntil, now, jobId, owner],
  );
}

export function finishJob(
  sql: Sql,
  jobId: string,
  result: Record<string, unknown>,
): void {
  const now = nowIso();
  sql.run(
    `UPDATE jobs
     SET state = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL,
         lease_until = NULL, finished_at = ?, updated_at = ?
     WHERE id = ?`,
    [JSON.stringify(result), now, now, jobId],
  );
}

export function failJob(
  sql: Sql,
  job: JobRow,
  error: { code: string; message: string; retryable: boolean },
  backoffMs: number,
): void {
  const now = new Date();
  const nowText = now.toISOString();
  const retry = error.retryable && job.attempts < job.max_attempts;
  if (!retry) {
    sql.run(
      `UPDATE jobs SET state = 'failed', error_code = ?, error_message = ?, lease_until = NULL, finished_at = ?, updated_at = ? WHERE id = ?`,
      [error.code, error.message.slice(0, 500), nowText, nowText, job.id],
    );
    return;
  }
  const runAfter = new Date(
    now.getTime() + backoffMs * job.attempts,
  ).toISOString();
  sql.run(
    `UPDATE jobs
     SET state = 'retrying', error_code = ?, error_message = ?, run_after = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ?`,
    [error.code, error.message.slice(0, 500), runAfter, nowText, job.id],
  );
}
