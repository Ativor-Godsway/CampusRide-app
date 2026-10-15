import { MemoryRateLimitStore, type RateLimitStore } from "./store";
import type { LimitRule } from "./rules";

/** One limit to apply: a rule, and the subject it counts against (a phone, an account id, an IP…). */
export interface LimitCheck {
  rule: LimitRule;
  subject: string;
}

export type LimitOutcome =
  | { ok: true }
  | {
      ok: false;
      /** The limit that refused (the one with the longest wait, if several). */
      rule: LimitRule;
      retryAfterMs: number;
    };

export interface LimitStatus {
  rule: LimitRule;
  used: number;
  max: number;
  /** Ms until the window resets (0 when nothing is counted). */
  resetsInMs: number;
  blocked: boolean;
}

/** The counter key: rule name and subject, e.g. "otp.send.15m|+233541234567". */
export function counterKey(rule: LimitRule, subject: string): string {
  return `${rule.name}|${subject}`;
}

/**
 * Applies limits. `consume` checks every limit of a request together: all
 * are counted, or — if any refuses — none is, so being refused by one limit
 * never uses up another (being turned away by the IP backstop doesn't spend
 * a person's own allowance).
 */
export class RateLimiter {
  constructor(private store: RateLimitStore) {}

  useStore(store: RateLimitStore): void {
    this.store = store;
  }

  async consume(checks: readonly LimitCheck[], now: number = Date.now()): Promise<LimitOutcome> {
    const taken: string[] = [];
    for (const [i, check] of checks.entries()) {
      const key = counterKey(check.rule, check.subject);
      const result = await this.store.take(key, check.rule.windowMs, check.rule.max, now);
      if (result.allowed) {
        taken.push(key);
        continue;
      }
      for (const k of taken) await this.store.release(k, now);
      // Say the longest wait among every limit that is full, so a retry
      // after it isn't refused again by another one.
      let refusal = { rule: check.rule, retryAfterMs: Math.max(0, result.resetAt - now) };
      for (const later of checks.slice(i + 1)) {
        const count = await this.store.get(counterKey(later.rule, later.subject), now);
        if (count && count.count >= later.rule.max && count.resetAt - now > refusal.retryAfterMs) {
          refusal = { rule: later.rule, retryAfterMs: count.resetAt - now };
        }
      }
      return { ok: false, ...refusal };
    }
    return { ok: true };
  }

  /** Un-counts one hit of a limit (the thing it guarded didn't happen after all). */
  async release(check: LimitCheck, now: number = Date.now()): Promise<void> {
    await this.store.release(counterKey(check.rule, check.subject), now);
  }

  async status(check: LimitCheck, now: number = Date.now()): Promise<LimitStatus> {
    const count = await this.store.get(counterKey(check.rule, check.subject), now);
    const used = count?.count ?? 0;
    return {
      rule: check.rule,
      used,
      max: check.rule.max,
      resetsInMs: count ? Math.max(0, count.resetAt - now) : 0,
      blocked: used >= check.rule.max,
    };
  }

  async clear(check: LimitCheck): Promise<void> {
    await this.store.clear(counterKey(check.rule, check.subject));
  }
}

/** The server's one limiter. In memory today; see store.ts for moving to Redis. */
export const limiter = new RateLimiter(new MemoryRateLimitStore());

/** Swap the store (Redis, or a fresh memory store between tests). */
export function setRateLimitStore(store: RateLimitStore): void {
  limiter.useStore(store);
}

/** Thrown by a service when a limit refuses; routes answer it with a 429. */
export class RateLimitedError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly rule: LimitRule,
  ) {
    super(`Rate limited by ${rule.name}`);
    this.name = "RateLimitedError";
  }
}

/** consume(), throwing RateLimitedError when refused. */
export async function enforce(checks: readonly LimitCheck[], now?: number): Promise<void> {
  const outcome = await limiter.consume(checks, now);
  if (!outcome.ok) throw new RateLimitedError(outcome.retryAfterMs, outcome.rule);
}
