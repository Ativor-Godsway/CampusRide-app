/**
 * Where rate-limit counters live. ONE interface for every limit in the
 * server (HTTP routes, login codes, sockets, SOS texts), so moving to Redis
 * when there is more than one server instance means writing one class:
 *
 *   take    -> a Lua script: INCR only if below max, PEXPIRE on the first hit
 *   release -> DECR (never below 0)
 *   get     -> GET + PTTL
 *   clear   -> DEL
 *
 * and passing it to setRateLimitStore at startup. Nothing else changes.
 *
 * Windows are fixed and start at a key's first hit: "5 per 15 minutes" means
 * five, then a wait until 15 minutes after the first. A refused request is
 * not counted, so hammering the button never makes the wait longer.
 */
export interface WindowCount {
  count: number;
  /** When the window ends and the count starts again (epoch ms). */
  resetAt: number;
}

export interface TakeResult extends WindowCount {
  allowed: boolean;
}

export interface RateLimitStore {
  /** Counts one hit if fewer than `max` are already counted in the window; otherwise refuses without counting. */
  take(key: string, windowMs: number, max: number, now: number): Promise<TakeResult>;
  /** Un-counts one hit (another limit on the same request refused it). */
  release(key: string, now: number): Promise<void>;
  /** The live count for a key, or null when it has none. */
  get(key: string, now: number): Promise<WindowCount | null>;
  clear(key: string): Promise<void>;
}

/**
 * The in-memory store: right for one server instance. Counters are lost on
 * restart (a deploy, or Render's free plan sleeping), which only ever means
 * someone gets a fresh allowance early.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly counts = new Map<string, WindowCount>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** Far more keys than a campus produces; past it, expired ones go first, then the oldest. */
    private readonly maxKeys = 200_000,
    sweepEveryMs = 60_000,
  ) {
    if (sweepEveryMs > 0) {
      this.sweeper = setInterval(() => this.sweep(Date.now()), sweepEveryMs);
      this.sweeper.unref?.();
    }
  }

  async take(key: string, windowMs: number, max: number, now: number): Promise<TakeResult> {
    let entry = this.live(key, now);
    if (!entry) {
      if (this.counts.size >= this.maxKeys) this.makeRoom(now);
      entry = { count: 0, resetAt: now + windowMs };
      this.counts.set(key, entry);
    }
    if (entry.count >= max) return { allowed: false, count: entry.count, resetAt: entry.resetAt };
    entry.count += 1;
    return { allowed: true, count: entry.count, resetAt: entry.resetAt };
  }

  async release(key: string, now: number): Promise<void> {
    const entry = this.live(key, now);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async get(key: string, now: number): Promise<WindowCount | null> {
    const entry = this.live(key, now);
    return entry ? { ...entry } : null;
  }

  async clear(key: string): Promise<void> {
    this.counts.delete(key);
  }

  /** Drops every expired window. Runs on a timer; also callable directly. */
  sweep(now: number): void {
    for (const [key, entry] of this.counts) if (entry.resetAt <= now) this.counts.delete(key);
  }

  /** How many keys are held (for tests and diagnostics). */
  get size(): number {
    return this.counts.size;
  }

  stop(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private live(key: string, now: number): WindowCount | undefined {
    const entry = this.counts.get(key);
    if (entry && entry.resetAt <= now) {
      this.counts.delete(key);
      return undefined;
    }
    return entry;
  }

  private makeRoom(now: number): void {
    this.sweep(now);
    // Still full: drop the oldest keys (a Map iterates in insertion order).
    for (const key of this.counts.keys()) {
      if (this.counts.size < this.maxKeys) break;
      this.counts.delete(key);
    }
  }
}
