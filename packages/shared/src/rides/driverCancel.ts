/**
 * Why a DRIVER cancelled a rider's pickup ("Cancel pickup" on the trip
 * screen and in the Stops list), before the rider was picked up.
 *
 * Not "Rider didn't show": that one (NO_SHOW, 3 minutes after arriving)
 * cancels the rider's booking and is not counted against the driver. A
 * driver cancel sends the rider straight back to searching for another
 * driver, and is counted as the driver's cancellation in admin (tracking
 * only — no penalty).
 */
export const DRIVER_CANCEL_REASONS = [
  "RIDER_NOT_RESPONDING",
  "CANT_REACH_PICKUP",
  "CAR_PROBLEM",
  "SAFETY_CONCERN",
  "OTHER",
] as const;

export type DriverCancelReason = (typeof DRIVER_CANCEL_REASONS)[number];

/** Longest note a driver may add. Also the DB column width. */
export const DRIVER_CANCEL_NOTE_MAX = 200;

/** Driver-facing wording (the admin site shows the same). Display only. */
export const DRIVER_CANCEL_REASON_LABELS: Record<DriverCancelReason, string> = {
  RIDER_NOT_RESPONDING: "Rider not responding",
  CANT_REACH_PICKUP: "Can't reach pickup",
  CAR_PROBLEM: "Car problem",
  SAFETY_CONCERN: "Safety concern",
  OTHER: "Other",
};

export function isDriverCancelReason(value: unknown): value is DriverCancelReason {
  return typeof value === "string" && (DRIVER_CANCEL_REASONS as readonly string[]).includes(value);
}

export type DriverCancelInput =
  | { ok: true; reason: DriverCancelReason | null; note: string | null }
  | { ok: false; error: string };

/**
 * The optional `{ reason, note }` of a driver's pickup cancel. Both are
 * optional: driver app builds from before the reasons send no body at all
 * (and can only cancel a rider still WAITING). A blank note is null; a note
 * needs a reason.
 */
export function parseDriverCancelInput(body: unknown): DriverCancelInput {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const { reason, note } = record;
  if (reason === undefined || reason === null) {
    if (note !== undefined && note !== null && note !== "") return { ok: false, error: "note requires a reason" };
    return { ok: true, reason: null, note: null };
  }
  if (!isDriverCancelReason(reason)) {
    return { ok: false, error: `reason must be one of ${DRIVER_CANCEL_REASONS.join(" | ")}` };
  }
  if (note === undefined || note === null) return { ok: true, reason, note: null };
  if (typeof note !== "string") return { ok: false, error: "note must be a string" };
  const trimmed = note.trim();
  if (trimmed.length > DRIVER_CANCEL_NOTE_MAX) {
    return { ok: false, error: `note must be at most ${DRIVER_CANCEL_NOTE_MAX} characters` };
  }
  return { ok: true, reason, note: trimmed === "" ? null : trimmed };
}

/** Longest reason an admin may give for cancelling a ride or a seat (kept in the audit log). */
export const ADMIN_CANCEL_REASON_MAX = 500;
