import type { Sql } from './sqlite.js';

type Part = {
  upload_session_id: string;
  part_number: number;
  etag: string;
  checksum: string | null;
  bytes: number;
  object_key: string;
  completed_at: string;
};

const SESSION_SELECT = `
SELECT session_id AS id, id AS file_id, tenant_id, session_owner_id AS owner_id,
  session_status AS status, transport, part_size, declared_bytes, part_count, expires_at,
  idempotency_key, declared_mime, original_name AS filename, preset,
  COALESCE(session_metadata_json, metadata_json) AS metadata_json,
  session_checksum AS checksum, session_created_at AS created_at,
  storage_upload_id, session_object_key AS object_key
FROM filevora_assets
WHERE session_id IS NOT NULL`;

/**
 * Host databases only contain filevora_assets and filevora_asset_versions.
 * Statements aimed at upload sessions, parts, or audit are answered from the asset row.
 */
export function hostSql(inner: Sql): Sql {
  return {
    exec(statement) {
      return inner.exec(rewrite(statement));
    },
    async get<T>(statement: string, params?: unknown[]) {
      const routed = await route(inner, 'get', statement, params ?? []);
      if (routed.handled) return routed.value as T | undefined;
      return inner.get(rewrite(statement), params);
    },
    async all<T>(statement: string, params?: unknown[]) {
      const routed = await route(inner, 'all', statement, params ?? []);
      if (routed.handled) return routed.value as T[];
      return inner.all(rewrite(statement), params);
    },
    async run(statement: string, params?: unknown[]) {
      const routed = await route(inner, 'run', statement, params ?? []);
      if (routed.handled) return;
      await inner.run(rewrite(statement), params);
    },
    transaction(fn) {
      return inner.transaction(fn);
    },
    close() {
      return inner.close();
    },
  };
}

function rewrite(statement: string): string {
  return statement
    .replace(/\bfiles\b/g, 'filevora_assets')
    .replace(/\bvariants\b/g, 'filevora_asset_versions');
}

async function route(
  inner: Sql,
  kind: 'get' | 'all' | 'run',
  statement: string,
  params: unknown[],
): Promise<{ handled: boolean; value?: unknown }> {
  const sql = statement.replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO audit_events\b/i.test(sql))
    return { handled: true, value: empty(kind) };
  if (/\bupload_sessions\b/i.test(sql)) {
    return { handled: true, value: await sessions(inner, kind, sql, params) };
  }
  if (/\bupload_parts\b/i.test(sql)) {
    return { handled: true, value: await parts(inner, kind, sql, params) };
  }
  return { handled: false };
}

function empty(kind: 'get' | 'all' | 'run'): unknown {
  if (kind === 'all') return [];
  return undefined;
}

async function sessions(
  inner: Sql,
  kind: 'get' | 'all' | 'run',
  sql: string,
  params: unknown[],
): Promise<unknown> {
  if (/^INSERT INTO upload_sessions\b/i.test(sql)) {
    const [
      sessionId,
      fileId,
      ,
      ownerId,
      transport,
      partSize,
      declaredBytes,
      partCount,
      expiresAt,
      idempotencyKey,
      ,
      ,
      ,
      metadataJson,
      checksum,
      createdAt,
    ] = params;
    await inner.run(
      `UPDATE filevora_assets SET session_id = ?, session_owner_id = ?, session_status = 'authorized',
        transport = ?, part_size = ?, declared_bytes = ?, part_count = ?, expires_at = ?,
        idempotency_key = ?, session_checksum = ?, session_metadata_json = ?, session_created_at = ?,
        parts_json = '[]' WHERE id = ?`,
      [
        sessionId,
        ownerId,
        transport,
        partSize,
        declaredBytes,
        partCount,
        expiresAt,
        idempotencyKey,
        checksum,
        metadataJson,
        createdAt,
        fileId,
      ],
    );
    return undefined;
  }
  if (
    /^UPDATE upload_sessions SET storage_upload_id = \?, object_key = \? WHERE id = \?$/i.test(
      sql,
    )
  ) {
    await inner.run(
      'UPDATE filevora_assets SET storage_upload_id = ?, session_object_key = ? WHERE session_id = ?',
      params,
    );
    return undefined;
  }
  if (/^UPDATE upload_sessions SET status = \? WHERE id = \?$/i.test(sql)) {
    await inner.run(
      'UPDATE filevora_assets SET session_status = ? WHERE session_id = ?',
      params,
    );
    return undefined;
  }
  if (/tenant_id = \? AND idempotency_key = \?/i.test(sql)) {
    const rows = await inner.all(
      `${SESSION_SELECT} AND tenant_id = ? AND idempotency_key = ?`,
      params,
    );
    return kind === 'all' ? rows : rows[0];
  }
  if (/id = \? AND tenant_id = \? AND owner_id = \?/i.test(sql)) {
    const rows = await inner.all(
      `${SESSION_SELECT} AND session_id = ? AND tenant_id = ? AND session_owner_id = ?`,
      params,
    );
    return kind === 'all' ? rows : rows[0];
  }
  if (/WHERE id = \?$/i.test(sql)) {
    const rows = await inner.all(
      `${SESSION_SELECT} AND session_id = ?`,
      params,
    );
    return kind === 'all' ? rows : rows[0];
  }
  throw new Error(`Unsupported upload session statement: ${sql}`);
}

async function parts(
  inner: Sql,
  kind: 'get' | 'all' | 'run',
  sql: string,
  params: unknown[],
): Promise<unknown> {
  if (/^DELETE FROM upload_parts/i.test(sql)) {
    const [sessionId, partNumber] = params;
    const current = await readParts(inner, String(sessionId));
    await writeParts(
      inner,
      String(sessionId),
      current.filter((part) => part.part_number !== Number(partNumber)),
    );
    return undefined;
  }
  if (/^INSERT INTO upload_parts/i.test(sql)) {
    const [
      sessionId,
      partNumber,
      etag,
      checksum,
      bytes,
      objectKey,
      completedAt,
    ] = params;
    const current = await readParts(inner, String(sessionId));
    const next = current.filter(
      (part) => part.part_number !== Number(partNumber),
    );
    next.push({
      upload_session_id: String(sessionId),
      part_number: Number(partNumber),
      etag: String(etag),
      checksum: checksum == null ? null : String(checksum),
      bytes: Number(bytes),
      object_key: String(objectKey),
      completed_at: String(completedAt),
    });
    await writeParts(inner, String(sessionId), next);
    return undefined;
  }
  const sessionId = String(params[0] ?? '');
  const rows = (await readParts(inner, sessionId)).sort(
    (left, right) => left.part_number - right.part_number,
  );
  return kind === 'get' ? rows[0] : rows;
}

async function readParts(inner: Sql, sessionId: string): Promise<Part[]> {
  const row = await inner.get<{ parts_json: string | null }>(
    'SELECT parts_json FROM filevora_assets WHERE session_id = ?',
    [sessionId],
  );
  if (!row?.parts_json) return [];
  return JSON.parse(row.parts_json) as Part[];
}

async function writeParts(
  inner: Sql,
  sessionId: string,
  parts: Part[],
): Promise<void> {
  await inner.run(
    'UPDATE filevora_assets SET parts_json = ? WHERE session_id = ?',
    [JSON.stringify(parts), sessionId],
  );
}
