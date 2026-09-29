/**
 * Why a RIDER cancelled, as they told us in the cancel sheet.
 *
 * Deliberately separate from `RideCancelReason` (Ride.cancelReason), which
 * records the SYSTEM's reason for every CANCELLED transition —
 * RIDER_CANCELLED, MERGED_INTO_ANOTHER_RIDE, … — and drives app logic
 * (e.g. following a merged ride). This is product feedback only.
 */
export const RIDER_CANCEL_REASONS = [
  "WAITING_TOO_LONG",
  "CHANGED_PLANS",
  "WRONG_ADDRESS",
  "FOUND_ANOTHER_RIDE",
  "PRICE",
  "DRIVER_TOO_SLOW",
  "DRIVER_ASKED_TO_CANCEL",
  "OTHER",
] as const;

export type RiderCancelReason = (typeof RIDER_CANCEL_REASONS)[number];

/** Longest note a rider may add (with "Other"). Also the DB column width. */
export const RIDER_CANCEL_NOTE_MAX = 200;

/** Reasons that only make sense once a driver has been assigned. */
export const DRIVER_STAGE_CANCEL_REASONS: readonly RiderCancelReason[] = [
  "DRIVER_TOO_SLOW",
  "DRIVER_ASKED_TO_CANCEL",
];

/**
 * "Driver asked me to cancel" can mean a driver dodging a trip while keeping
 * their acceptance rate — the admin ride list flags it.
 */
export const FLAGGED_RIDER_CANCEL_REASONS: readonly RiderCancelReason[] = [
  "DRIVER_ASKED_TO_CANCEL",
];

/** Rider-facing wording; the admin site uses the same labels. */
export const RIDER_CANCEL_REASON_LABELS: Record<RiderCancelReason, string> = {
  WAITING_TOO_LONG: "Waiting too long",
  CHANGED_PLANS: "Changed my plans",
  WRONG_ADDRESS: "Wrong pickup or destination",
  FOUND_ANOTHER_RIDE: "Found another ride",
  PRICE: "Price",
  DRIVER_TOO_SLOW: "Driver is taking too long",
  DRIVER_ASKED_TO_CANCEL: "Driver asked me to cancel",
  OTHER: "Other",
};

/** The chips to offer, in order, for the ride's current stage. */
export function riderCancelReasonsFor(stage: "searching" | "driver_assigned"): RiderCancelReason[] {
  const common: RiderCancelReason[] = [
    "WAITING_TOO_LONG",
    "CHANGED_PLANS",
    "WRONG_ADDRESS",
    "FOUND_ANOTHER_RIDE",
    "PRICE",
  ];
  return stage === "driver_assigned"
    ? ["DRIVER_TOO_SLOW", "DRIVER_ASKED_TO_CANCEL", ...common, "OTHER"]
    : [...common, "OTHER"];
}

export type RiderCancelInput =
  | { ok: true; reason: RiderCancelReason | null; note: string | null }
  | { ok: false; error: string };

/**
 * Validates the optional `{ reason, note }` body of POST /rides/:id/cancel.
 *
 * Both are optional so an older app build that sends neither can still
 * cancel. When present: `reason` must be a known value (and a driver-stage
 * reason only once a driver is assigned); `note` must be a string of at most
 * RIDER_CANCEL_NOTE_MAX characters after trimming, and may only accompany a
 * reason. A blank note is stored as null.
 */
export function parseRiderCancelInput(
  body: unknown,
  opts: { hasDriver: boolean },
): RiderCancelInput {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const { reason, note } = record;

  if (reason === undefined || reason === null) {
    if (note !== undefined && note !== null && note !== "") {
      return { ok: false, error: "note requires a reason" };
    }
    return { ok: true, reason: null, note: null };
  }

  if (typeof reason !== "string" || !(RIDER_CANCEL_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: `reason must be one of ${RIDER_CANCEL_REASONS.join(" | ")}` };
  }
  const typed = reason as RiderCancelReason;
  if (!opts.hasDriver && DRIVER_STAGE_CANCEL_REASONS.includes(typed)) {
    return { ok: false, error: `${typed} only applies once a driver is assigned` };
  }

  if (note === undefined || note === null) return { ok: true, reason: typed, note: null };
  if (typeof note !== "string") return { ok: false, error: "note must be a string" };
  const trimmed = note.trim();
  if (trimmed.length > RIDER_CANCEL_NOTE_MAX) {
    return { ok: false, error: `note must be at most ${RIDER_CANCEL_NOTE_MAX} characters` };
  }
  return { ok: true, reason: typed, note: trimmed === "" ? null : trimmed };
}
