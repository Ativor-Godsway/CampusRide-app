/**
 * What the driver's trip screen shows, from three sources that can
 * disagree for a moment:
 *
 * 1. the SERVER's trip (the truth, refetched after every action);
 * 2. this device's optimistic steps on each seat ("picked up" the instant
 *    the slider finishes, before the server has answered);
 * 3. a PROVISIONAL trip built from a request just accepted, shown only
 *    until the server's trip arrives.
 *
 * Pure, so the rules are tested once — including the bug of 2026-10-13: when
 * a trip ended, the server stopped listing it, and the screen fell back to
 * the provisional trip from the original accept. That looked like a fresh
 * trip with the first rider still waiting at their pickup ("Pick up Test at
 * Balme Library", "1 of 4"), it cancelled the "Trip complete" screen, and
 * acting on it got "This rider has already been dropped off."
 */
import type { PassengerStatus } from "../types/ride";

/** How far along a seat is; the screen never shows a seat going backwards. */
export const SEAT_RANK: Record<PassengerStatus, number> = {
  WAITING: 0,
  ARRIVED: 1,
  PICKED_UP: 2,
  DROPPED_OFF: 3,
  CANCELLED: 3,
};

export interface SeatOverlay {
  status: PassengerStatus;
  arrivedAt?: string;
  /**
   * An undone step, and the status it undoes (PICKED_UP for a pickup): the
   * seat goes BACK to `status` on screen at once, though the server still
   * has it at `undoing` until the undo lands.
   */
  undoing?: PassengerStatus;
}

/**
 * The seats as the screen shows them: each seat's optimistic step, if this
 * device has taken one the server hasn't caught up with — but never behind
 * what the server already says (a stale refetch can't undo a step, and a
 * step can't undo the server). An undo overlay is the one exception: it is
 * shown as it is, backwards, and an ARRIVED → WAITING undo clears the wait timer.
 */
export function applySeatOverlays<P extends { id: string; status: PassengerStatus; arrivedAt?: string | null }>(
  passengers: readonly P[],
  overlays: Readonly<Record<string, SeatOverlay>>,
): P[] {
  return passengers.map((p) => {
    const o = overlays[p.id];
    if (!o) return p;
    if (o.undoing) {
      if (p.status !== o.undoing) return p;
      return { ...p, status: o.status, ...(o.status === "WAITING" ? { arrivedAt: null } : {}) };
    }
    if (SEAT_RANK[o.status] <= SEAT_RANK[p.status]) return p;
    return { ...p, status: o.status, ...(o.arrivedAt ? { arrivedAt: o.arrivedAt } : {}) };
  });
}

/**
 * Overlays the server has caught up with (or gone past) are dropped: from
 * then on the server's status is shown. An undo overlay is dropped once the
 * server has moved off the status it undoes and the seat has nothing left
 * to send (`busy`): until the step it undoes has gone out, the server is
 * BEHIND the undo, and a read taken then would flash the step back. Returns
 * the same object when nothing changed.
 */
export function settleSeatOverlays(
  overlays: Readonly<Record<string, SeatOverlay>>,
  passengers: readonly { id: string; status: PassengerStatus }[],
  busy: ReadonlySet<string> = new Set(),
): Readonly<Record<string, SeatOverlay>> {
  let changed = false;
  const next = { ...overlays };
  for (const p of passengers) {
    const o = next[p.id];
    if (!o) continue;
    const caughtUp = o.undoing
      ? !busy.has(p.id) && p.status !== o.undoing
      : SEAT_RANK[p.status] >= SEAT_RANK[o.status];
    if (caughtUp) {
      delete next[p.id];
      changed = true;
    }
  }
  return changed ? next : overlays;
}

export type ClaimState = "sending" | "confirmed" | "refused";

/**
 * Which trip to show:
 * - "server" whenever the server has the trip;
 * - "provisional" only while an accept is on its way, or confirmed but the
 *   server's trip hasn't been seen yet (a second or two);
 * - "none" otherwise — in particular once the server has had the trip and
 *   stops listing it: it ENDED. Never the provisional trip again.
 */
export function chooseTripSource(input: {
  hasServerRide: boolean;
  claimState: ClaimState | null;
  /** The server has listed this trip at least once since it was accepted. */
  serverSeen: boolean;
}): "server" | "provisional" | "none" {
  if (input.hasServerRide) return "server";
  if (input.claimState === "sending") return "provisional";
  if (input.claimState === "confirmed" && !input.serverSeen) return "provisional";
  return "none";
}

/**
 * Whether "Trip complete" (shown the moment this device dropped the last
 * rider off) should give way to the trip again: only if the SERVER still
 * lists the trip with stops to do — a drop-off it refused. Never because of
 * a provisional trip, and never because the trip is gone (that's the end).
 */
export function summaryGivesWay(input: { source: "server" | "provisional" | "none"; upcomingStops: number }): boolean {
  return input.source === "server" && input.upcomingStops > 0;
}
