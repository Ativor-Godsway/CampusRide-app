/**
 * The admin dashboard's server cache (docs/admin-metrics.md): an aggregate
 * answer is worked out at most once per AGGREGATE_TTL_MS for the same
 * question (endpoint + period + filters), however many admins and browser
 * tabs ask. The database plan bills compute, so the dashboard must never
 * cost more than one query set a minute per page.
 *
 * Two people asking at once share one computation (the promise is cached).
 * A failed computation is not kept. An admin action that changes what a page
 * shows (a payment recorded, a driver suspended, an SOS handled) clears the
 * cache, so the change shows at once.
 *
 * In this server's memory (one instance), like the live positions.
 */

export const AGGREGATE_TTL_MS = 60_000;
/** Far more distinct questions than a few admins ask in a minute. */
const MAX_ENTRIES = 500;

interface Entry {
  at: number;
  value: Promise<unknown>;
}

const entries = new Map<string, Entry>();

/** The cached answer for `key`, or `compute()`'s (kept for `ttlMs`). */
export function cached<T>(
  key: string,
  compute: () => Promise<T>,
  ttlMs: number = AGGREGATE_TTL_MS,
  now: number = Date.now(),
): Promise<T> {
  const hit = entries.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = compute();
  entries.delete(key);
  entries.set(key, { at: now, value });
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return value;
}

/** When `key` was last computed (epoch ms), if it is cached. */
export function cachedAt(key: string): number | null {
  return entries.get(key)?.at ?? null;
}

/** Forgets every cached answer (or those whose key starts with `prefix`). */
export function clearAdminCache(prefix?: string): void {
  if (prefix === undefined) {
    entries.clear();
    return;
  }
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}
