/**
 * Keeps push notifications sensible (services/push/pushService.ts):
 *
 * - The same notification is not sent twice: a repeat of (person, kind, ride)
 *   inside its dedupe window is dropped. Retried requests and re-broadcasts
 *   would otherwise ping a phone again for news it already has.
 * - Nobody gets more than `perUserMax` notifications in `perUserWindowMs`,
 *   whatever happens on the server.
 *
 * In memory, per server process. The API runs as one instance; after a
 * restart the windows start empty, which at worst repeats one notification.
 */
export interface PushRateLimitOptions {
  perUserMax: number;
  perUserWindowMs: number;
}

export const DEFAULT_PUSH_RATE_LIMITS: PushRateLimitOptions = {
  perUserMax: 6,
  perUserWindowMs: 60_000,
};

export class PushRateLimiter {
  private readonly sentAt = new Map<string, number[]>();
  private readonly seenUntil = new Map<string, number>();

  constructor(private readonly options: PushRateLimitOptions = DEFAULT_PUSH_RATE_LIMITS) {}

  /**
   * True if this person may be sent this notification now; records it if so.
   * `dedupeKey` names the notification ("DRIVER_ARRIVED:<rideId>").
   */
  allow(userId: string, dedupeKey: string, dedupeMs: number, now: number = Date.now()): boolean {
    const seenKey = `${userId}|${dedupeKey}`;
    const until = this.seenUntil.get(seenKey);
    if (until !== undefined && until > now) return false;

    const windowStart = now - this.options.perUserWindowMs;
    const recent = (this.sentAt.get(userId) ?? []).filter((t) => t > windowStart);
    if (recent.length >= this.options.perUserMax) {
      this.sentAt.set(userId, recent);
      return false;
    }

    recent.push(now);
    this.sentAt.set(userId, recent);
    this.seenUntil.set(seenKey, now + dedupeMs);
    return true;
  }

  /** Forgets expired entries so memory stays flat. Called on a timer. */
  sweep(now: number = Date.now()): void {
    for (const [key, until] of this.seenUntil) if (until <= now) this.seenUntil.delete(key);
    const windowStart = now - this.options.perUserWindowMs;
    for (const [userId, times] of this.sentAt) {
      const recent = times.filter((t) => t > windowStart);
      if (recent.length === 0) this.sentAt.delete(userId);
      else this.sentAt.set(userId, recent);
    }
  }

  /** Number of tracked entries, for tests. */
  get size(): number {
    return this.seenUntil.size + this.sentAt.size;
  }
}
