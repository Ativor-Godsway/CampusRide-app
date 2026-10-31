/**
 * Requests waiting for a driver right now, in this server's memory only:
 * the admin live map reads them every few seconds without touching the
 * database. Kept up to date by dispatch (services/ride/dispatch.ts: a
 * request offered to drivers, and closed) and by drivers' answers
 * (services/stats/rideOffers.ts).
 *
 * Lost on a restart: a request still waiting is offered again within
 * seconds of riders' apps reconnecting, and the map shows it again then.
 * Review demo requests never appear.
 */

export interface LiveRequest {
  rideId: string;
  riderId: string;
  riderName: string;
  type: "LONE" | "SHARED";
  /** When the rider asked (epoch ms). */
  requestedAt: number;
  pickup: { latitude: number; longitude: number; label: string } | null;
  pickupZoneId: string;
  pickupLabel: string;
  dropoffLabel: string;
  offeredTo: Set<string>;
  declinedBy: Set<string>;
  timedOutWith: Set<string>;
  /** Last change (epoch ms); entries untouched for FORGET_AFTER_MS are dropped. */
  touchedAt: number;
}

/** A request waits at most a few minutes; anything older was closed while this server wasn't looking. */
const FORGET_AFTER_MS = 15 * 60_000;
const MAX_REQUESTS = 2_000;

const open = new Map<string, LiveRequest>();

/** A request was (re)offered: to these drivers (none when nobody was eligible). */
export function noteRequestOffered(
  request: Omit<LiveRequest, "offeredTo" | "declinedBy" | "timedOutWith" | "touchedAt">,
  driverUserIds: readonly string[],
  now: number = Date.now(),
): void {
  const existing = open.get(request.rideId);
  const entry: LiveRequest = existing ?? {
    ...request,
    offeredTo: new Set(),
    declinedBy: new Set(),
    timedOutWith: new Set(),
    touchedAt: now,
  };
  for (const id of driverUserIds) entry.offeredTo.add(id);
  entry.touchedAt = now;
  open.set(request.rideId, entry);
  if (open.size > MAX_REQUESTS) {
    const oldest = open.keys().next().value;
    if (oldest !== undefined) open.delete(oldest);
  }
}

/** A driver declined, or let the offer time out. */
export function noteRequestAnswer(rideId: string, driverUserId: string, outcome: "DECLINED" | "TIMED_OUT", now: number = Date.now()): void {
  const entry = open.get(rideId);
  if (!entry) return;
  (outcome === "DECLINED" ? entry.declinedBy : entry.timedOutWith).add(driverUserId);
  entry.touchedAt = now;
}

/** Taken, cancelled or out of time: no longer waiting. */
export function noteRequestClosed(rideId: string): void {
  open.delete(rideId);
}

/** Every request waiting now, oldest first. */
export function waitingRequests(now: number = Date.now()): LiveRequest[] {
  for (const [id, r] of open) if (now - r.touchedAt > FORGET_AFTER_MS) open.delete(id);
  return [...open.values()].sort((a, b) => a.requestedAt - b.requestedAt);
}

/** Tests only. */
export function resetLiveRequestsForTests(): void {
  open.clear();
}
