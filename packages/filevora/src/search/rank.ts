import type { Sql } from '../metadata/sqlite.js';
import {
  storedFilterWhere,
  type ParsedListQuery,
} from '../server/list-query.js';
import { scoreToMicros } from './cursor.js';

export const SCAN_CHUNK_ROWS = 5000;

export interface RankHit {
  assetId: string;
  scoreMicros: number;
}

export interface RankInput {
  sql: Sql;
  tenantId: string;
  model: string;
  dimensions: number;
  queryVector: Float32Array;
  filters: ParsedListQuery;
  minScoreMicros: number;
  after?: { scoreMicros: number; assetId: string };
  /** Hits to return. One extra is tracked to know whether another page exists. */
  pageSize: number;
  chunkRows?: number;
}

export interface RankResult {
  /** At most pageSize hits, best first. */
  hits: RankHit[];
  /** True when more eligible matches exist after these hits. */
  hasMore: boolean;
  /** Embedded assets that passed the SQL filters and were scored. */
  candidatesScored: number;
}

/** Worse hits sort lower: lower score first, then lower id (order is score DESC, id DESC). */
function isWorse(left: RankHit, right: RankHit): boolean {
  if (left.scoreMicros !== right.scoreMicros) {
    return left.scoreMicros < right.scoreMicros;
  }
  return left.assetId < right.assetId;
}

/** Bounded min-heap that keeps the best `capacity` hits; the root is the worst kept hit. */
class TopHits {
  private readonly items: RankHit[] = [];

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.items.length;
  }

  push(hit: RankHit): void {
    if (this.items.length < this.capacity) {
      this.items.push(hit);
      this.siftUp(this.items.length - 1);
      return;
    }
    const root = this.items[0];
    if (!root || !isWorse(root, hit)) return;
    this.items[0] = hit;
    this.siftDown(0);
  }

  sortedBestFirst(): RankHit[] {
    return [...this.items].sort((left, right) =>
      isWorse(left, right) ? 1 : isWorse(right, left) ? -1 : 0,
    );
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = this.items[index] as RankHit;
      const above = this.items[parent] as RankHit;
      if (!isWorse(current, above)) break;
      this.items[index] = above;
      this.items[parent] = current;
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    const length = this.items.length;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (
        left < length &&
        isWorse(this.items[left] as RankHit, this.items[smallest] as RankHit)
      ) {
        smallest = left;
      }
      if (
        right < length &&
        isWorse(this.items[right] as RankHit, this.items[smallest] as RankHit)
      ) {
        smallest = right;
      }
      if (smallest === index) return;
      const swap = this.items[index] as RankHit;
      this.items[index] = this.items[smallest] as RankHit;
      this.items[smallest] = swap;
      index = smallest;
    }
  }
}

/** Cosine similarity of two unit vectors. Four accumulators keep the loop tight. */
export function dot(
  left: Float32Array,
  right: Float32Array,
  length: number,
): number {
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  let index = 0;
  const unrolled = length - (length % 4);
  for (; index < unrolled; index += 4) {
    a += (left[index] as number) * (right[index] as number);
    b += (left[index + 1] as number) * (right[index + 1] as number);
    c += (left[index + 2] as number) * (right[index + 2] as number);
    d += (left[index + 3] as number) * (right[index + 3] as number);
  }
  for (; index < length; index += 1) {
    a += (left[index] as number) * (right[index] as number);
  }
  return a + b + c + d;
}

interface EmbeddingRow {
  asset_id: string;
  embedding: Uint8Array;
}

/**
 * Exact search. SQL applies every structured filter, vectors stream in keyset chunks,
 * and only the best `pageSize + 1` hits are ever held in memory.
 */
export async function rankEmbeddings(input: RankInput): Promise<RankResult> {
  const chunkRows = input.chunkRows ?? SCAN_CHUNK_ROWS;
  const { where, params: filterParams } = storedFilterWhere(
    input.filters,
    input.tenantId,
  );
  const statement = `SELECT asset_id, embedding FROM filevora_asset_embeddings
    WHERE tenant_id = ? AND model = ? AND dimensions = ? AND asset_id > ?
    AND asset_id IN (SELECT id FROM files WHERE ${where.join(' AND ')})
    ORDER BY asset_id ASC LIMIT ${Math.floor(chunkRows)}`;
  const heap = new TopHits(input.pageSize + 1);
  const scratch = new Float32Array(input.dimensions);
  const expectedBytes = input.dimensions * 4;
  let lastId = '';
  let candidatesScored = 0;
  for (;;) {
    const rows = await input.sql.all<EmbeddingRow>(statement, [
      input.tenantId,
      input.model,
      input.dimensions,
      lastId,
      ...filterParams,
    ]);
    for (const row of rows) {
      lastId = row.asset_id;
      const bytes = row.embedding;
      if (!bytes || bytes.byteLength !== expectedBytes) continue;
      const vector =
        (bytes.byteOffset & 3) === 0
          ? new Float32Array(bytes.buffer, bytes.byteOffset, input.dimensions)
          : copyInto(scratch, bytes);
      candidatesScored += 1;
      const scoreMicros = scoreToMicros(
        dot(input.queryVector, vector, input.dimensions),
      );
      if (scoreMicros < input.minScoreMicros) continue;
      if (
        input.after &&
        !(
          scoreMicros < input.after.scoreMicros ||
          (scoreMicros === input.after.scoreMicros &&
            row.asset_id < input.after.assetId)
        )
      ) {
        continue;
      }
      heap.push({ assetId: row.asset_id, scoreMicros });
    }
    if (rows.length < chunkRows) break;
  }
  const sorted = heap.sortedBestFirst();
  return {
    hits: sorted.slice(0, input.pageSize),
    hasMore: sorted.length > input.pageSize,
    candidatesScored,
  };
}

function copyInto(target: Float32Array, bytes: Uint8Array): Float32Array {
  new Uint8Array(target.buffer).set(bytes);
  return target;
}
