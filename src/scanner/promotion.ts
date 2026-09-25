// Dynamic Tier-A promotion (plan §B): when Tier B/C fires, the hot name is
// subscribed in Full mode and the least-recently-anomalous unpinned Tier-A name
// is evicted. Pinned names (open positions, indices, core F&O) are never evicted.

export class TierPromoter {
  readonly capacity: number;
  private members = new Map<string, number>(); // key -> last anomaly ts (or join ts)
  private pinned = new Set<string>();

  constructor(capacity: number, initial: string[] = [], now = 0) {
    this.capacity = capacity;
    for (const k of initial.slice(0, capacity)) this.members.set(k, now);
  }

  has(key: string): boolean {
    return this.members.has(key);
  }

  pin(key: string): void {
    this.pinned.add(key);
  }

  unpin(key: string): void {
    this.pinned.delete(key);
  }

  touch(key: string, ts: number): void {
    if (this.members.has(key)) this.members.set(key, ts);
  }

  /** Least-recently-anomalous unpinned member. */
  evictionCandidate(): string | undefined {
    let best: string | undefined;
    let bestTs = Infinity;
    for (const [k, ts] of this.members) {
      if (this.pinned.has(k)) continue;
      if (ts < bestTs) { bestTs = ts; best = k; }
    }
    return best;
  }

  /** Returns {evicted} when promoted, undefined if already a member or no room. */
  promote(key: string, ts: number): { evicted?: string } | undefined {
    if (this.members.has(key)) {
      this.members.set(key, ts);
      return undefined;
    }
    let evicted: string | undefined;
    if (this.members.size >= this.capacity) {
      evicted = this.evictionCandidate();
      if (!evicted) return undefined;
      this.members.delete(evicted);
    }
    this.members.set(key, ts);
    return { evicted };
  }

  keys(): string[] {
    return [...this.members.keys()];
  }
}
