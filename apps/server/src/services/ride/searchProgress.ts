import type { SearchScope } from "@rida/shared";

/**
 * What dispatch did for each request still searching, in this server's
 * memory only (no database write): who it was offered to, who declined it,
 * whether it went to drivers near the pickup or (nobody free there) to every
 * driver on campus, and how many live drivers' cars were looked at. Read by
 * the rider's search screen (services/ride/searchStatus.ts).
 *
 * One entry per search: a new search of the same ride ("Search again", the
 * driver had to cancel) has a new broadcastStartedAt and starts again from
 * nothing. Lost on a restart: the search status then works it out again from
 * dispatch's rules (dispatchPlan), which is what the drivers' lists show.
 */

export interface SearchProgress {
  /** The search it belongs to: the ride's broadcastStartedAt (epoch ms). */
  episode: number;
  offered: Set<string>;
  declined: Set<string>;
  scope: SearchScope;
  carsChecked: number;
  touchedAt: number;
}

/** A search lasts at most 30 minutes (the admin setting's top); anything older is forgotten. */
const FORGET_AFTER_MS = 40 * 60_000;
const MAX_SEARCHES = 2_000;

const searches = new Map<string, SearchProgress>();

function sweep(now: number): void {
  for (const [id, s] of searches) if (now - s.touchedAt > FORGET_AFTER_MS) searches.delete(id);
  while (searches.size > MAX_SEARCHES) {
    const oldest = searches.keys().next().value;
    if (oldest === undefined) break;
    searches.delete(oldest);
  }
}

/**
 * Dispatch offered this search to `driverIds` (a broadcast: the ride was
 * requested, searched again, or switched type). Within one search the
 * drivers add up; a search that reached every driver on campus says so.
 */
export function noteSearchDispatched(
  rideId: string,
  episode: number,
  plan: { driverIds: readonly string[]; scope: SearchScope; carsChecked: number },
  now: number = Date.now(),
): SearchProgress {
  const existing = searches.get(rideId);
  const same = existing?.episode === episode ? existing : null;
  const entry: SearchProgress = same ?? {
    episode,
    offered: new Set(),
    declined: new Set(),
    scope: plan.scope,
    carsChecked: 0,
    touchedAt: now,
  };
  for (const id of plan.driverIds) entry.offered.add(id);
  if (plan.scope === "campus") entry.scope = "campus";
  entry.carsChecked = Math.max(entry.carsChecked, plan.carsChecked);
  entry.touchedAt = now;
  searches.delete(rideId);
  searches.set(rideId, entry);
  sweep(now);
  return entry;
}

/** One more driver was offered it (their car got a free seat: dispatch.reofferToDriver). */
export function noteSearchOfferedTo(rideId: string, episode: number, driverUserId: string, now: number = Date.now()): void {
  const entry = searches.get(rideId);
  if (!entry || entry.episode !== episode) return;
  entry.offered.add(driverUserId);
  entry.touchedAt = now;
}

/** A driver declined it: they no longer have it. */
export function noteSearchDeclined(rideId: string, driverUserId: string, now: number = Date.now()): void {
  const entry = searches.get(rideId);
  if (!entry) return;
  entry.declined.add(driverUserId);
  entry.touchedAt = now;
}

/** This search, if this server saw it start. */
export function searchProgress(rideId: string, episode: number): SearchProgress | null {
  const entry = searches.get(rideId);
  return entry && entry.episode === episode ? entry : null;
}

/** Taken, cancelled or out of time. */
export function forgetSearch(rideId: string): void {
  searches.delete(rideId);
}

/** Tests only. */
export function resetSearchProgressForTests(): void {
  searches.clear();
}
