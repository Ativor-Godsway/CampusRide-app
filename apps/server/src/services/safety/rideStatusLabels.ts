/**
 * Human-readable ride statuses.
 *
 * The raw enum (`IN_PROGRESS`, `AWAITING_RIDER_DECISION`) is an internal
 * value. It was leaking verbatim into the SOS SMS, where the reader is an
 * alarmed friend or parent rather than a developer. Shared by the SMS and the
 * public tracking page so the two never describe the same ride differently.
 */
export const RIDE_STATUS_LABELS: Record<string, string> = {
  REQUESTED: "Looking for a driver",
  AWAITING_RIDER_DECISION: "Waiting on the rider",
  MATCHED: "Driver on the way",
  ARRIVED: "Driver has arrived",
  IN_PROGRESS: "On the trip",
  COMPLETED: "Trip completed",
  CANCELLED: "Trip cancelled",
};

/** Falls back to the raw status so an unmapped value is visible, not blank. */
export function rideStatusLabel(status: string): string {
  return RIDE_STATUS_LABELS[status] ?? status;
}
