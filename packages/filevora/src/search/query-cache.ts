export interface QueryVectorCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

/** Small TTL + LRU cache so later pages reuse the exact query vector from page one. */
export class QueryVectorCache {
  private readonly entries = new Map<
    string,
    { vector: Uint8Array; expiresAt: number }
  >();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: QueryVectorCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  static key(model: string, dimensions: number, query: string): string {
    return `${model}:${dimensions}:${query}`;
  }

  get(key: string): Uint8Array | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.vector;
  }

  set(key: string, vector: Uint8Array): void {
    this.entries.delete(key);
    this.entries.set(key, { vector, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}
