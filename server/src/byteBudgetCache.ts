// Engine Review C7 architecture (§2.3–§2.4) — byte-budgeted LRU cache.
//
// One small module, zero imports, shared by the joint-optimizer cache
// (rothOptimizer.ts) and the returns cache (retirementIndependentCheck.ts)
// so both caches get the identical accounting and eviction treatment.
//
// ACCOUNTING (deterministic walker estimator, §2.3): numbers 8 B, strings
// their UTF-8 byte length, booleans/null 4 B, arrays/objects their contents
// (keys included) plus 32 B per object/array for structure overhead — a
// deliberate OVER-estimate. Accounting need not be exact; it must be
// consistent and conservative (never under-estimate), so the cache never
// holds more than the budget claims. Do NOT account via
// JSON.stringify(...).length: values can be non-finite (NaN inputs price
// ok:true with NaN figures), and JSON.stringify(NaN) is `null` — it would
// both corrupt the accounting and silently rewrite the value.
// structuredClone (the actual transfer/clone mechanism) preserves
// non-finite values exactly, and the walker does too (a number is a
// number, whatever its value).
//
// An object reached twice through the same stored graph is counted once:
// structuredClone preserves shared references within one clone, so the
// stored copy shares it too. A cycle counts once and terminates (the
// visited set stops the walk).
//
// EVICTION (§2.4): insertion order = recency (a hit re-inserts its key).
// On a store, evict from the OLDEST end one entry at a time until total
// bytes are within budget. Single-entry guard: one entry alone over the
// budget is stored anyway as the sole entry, with a warning log — a cache
// that refuses to store its only entry is useless, and the log makes the
// overshoot visible instead of silent.
//
// The cache stores references as given: the joint cache clones on store
// and on hit at its call sites (mutation discipline, §2.5); the returns
// cache keeps its no-clone read trust (callers only read the arrays).
// This class clones nothing and knows nothing about either policy.

const utf8 = new TextEncoder();

export function estimateValueBytes(value: unknown): number {
  const seen = new Set<object>();
  const walk = (v: unknown): number => {
    switch (typeof v) {
      case "number":
      case "bigint":
        return 8;
      case "string":
        return utf8.encode(v).length;
      case "boolean":
        return 4;
      case "undefined":
        return 4;
      case "function":
      case "symbol":
        return 8;
      default:
        break;
    }
    if (v === null) return 4;
    if (typeof v !== "object") return 8;
    if (seen.has(v)) return 0;
    seen.add(v);
    // 32 B structure overhead, plus contents (object keys included).
    let bytes = 32;
    if (Array.isArray(v)) {
      for (const el of v) bytes += walk(el);
    } else {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        bytes += utf8.encode(k).length;
        bytes += walk(val);
      }
    }
    return bytes;
  };
  return walk(value);
}

export type ByteBudgetCacheStats = {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
};

export class ByteBudgetCache<V> {
  private readonly entriesMap = new Map<string, { value: V; bytes: number }>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly budgetBytes: number,
    private readonly label: string,
  ) {}

  get budget(): number {
    return this.budgetBytes;
  }

  get size(): number {
    return this.entriesMap.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  // A hit refreshes recency (delete + re-set). A miss is counted here,
  // so stats() reports the true hit/miss split for this cache.
  get(key: string): V | undefined {
    const entry = this.entriesMap.get(key);
    if (entry === undefined) {
      this.misses++;
      return undefined;
    }
    this.hits++;
    this.entriesMap.delete(key);
    this.entriesMap.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.entriesMap.has(key);
  }

  // Store, then evict oldest-first until within budget. `bytes` is the
  // caller's estimateValueBytes(value) for the value being stored; the
  // cache trusts it (the estimator is deterministic for a given value).
  set(key: string, value: V, bytes: number): void {
    const prev = this.entriesMap.get(key);
    if (prev !== undefined) {
      this.totalBytes -= prev.bytes;
      this.entriesMap.delete(key);
    }
    this.entriesMap.set(key, { value, bytes });
    this.totalBytes += bytes;
    while (this.totalBytes > this.budgetBytes && this.entriesMap.size > 1) {
      const oldest = this.entriesMap.keys().next();
      if (oldest.done) break;
      const oldestKey = oldest.value;
      const evicted = this.entriesMap.get(oldestKey)!;
      this.entriesMap.delete(oldestKey);
      this.totalBytes -= evicted.bytes;
      this.evictions++;
      console.debug(
        `[byte-budget-cache:${this.label}] evicted ${oldestKey} (${evicted.bytes} B); ` +
          `${this.entriesMap.size} entries, ${this.totalBytes} B remain`,
      );
    }
    if (this.totalBytes > this.budgetBytes) {
      // Single-entry guard (§2.4): the lone entry exceeds the budget.
      // Stored anyway as the sole entry, with a warning — never refused.
      console.error(
        `[byte-budget-cache:${this.label}] WARNING: single entry ${key} ` +
          `is ${this.totalBytes} B, over the ${this.budgetBytes} B budget; ` +
          `stored as the sole entry`,
      );
    }
  }

  stats(): ByteBudgetCacheStats {
    return {
      entries: this.entriesMap.size,
      bytes: this.totalBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  // Test-harness use only: empty the cache (counters keep their totals,
  // so a proof can still read hits/misses/evictions after a clear).
  clear(): void {
    this.entriesMap.clear();
    this.totalBytes = 0;
  }
}
