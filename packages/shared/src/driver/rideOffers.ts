/**
 * Ride offers: each new request pops up for the driver as ONE offer with a
 * countdown (Bolt/Uber style), the Home list staying as the backup. Pure, so
 * the queue rules — one at a time, nearest first, nothing expired, nothing
 * already handled — are tested once here and the app only renders them.
 */

/** How long an offer stays up, unless the server says otherwise (config.driverOfferSeconds). */
export const DEFAULT_OFFER_SECONDS = 15;

/** An offer with less time than this left isn't worth showing (it would vanish under the driver's thumb). */
export const MIN_OFFER_SHOW_MS = 4_000;

/** Why a driver passed on an offer — recorded for stats, never a penalty. */
export type OfferPassReason = "DECLINED" | "TIMED_OUT";

/** Why the server withdrew an offer from every driver it was offered to. */
export type OfferClosedReason = "TAKEN" | "CANCELLED" | "EXPIRED";

/** What the app needs to rank and time an offer. */
export interface QueueableOffer {
  rideId: string;
  /** Metres from the driver to the pickup (approximate), or null when unknown. */
  pickupDistanceMeters: number | null;
  /** ISO time the request was made. */
  createdAt: string;
  /** ISO time the request stops being offered at all (the 90 s dispatch window). */
  expiresAt: string;
}

/**
 * Nearest pickup first; unknown distances after measured ones; then the
 * request that has waited longest. The same order as the Home list.
 */
export function orderOffers<T extends QueueableOffer>(offers: readonly T[]): T[] {
  return [...offers].sort((a, b) => {
    const da = a.pickupDistanceMeters;
    const db = b.pickupDistanceMeters;
    if (da !== null && db !== null && da !== db) return da - db;
    if (da === null && db !== null) return 1;
    if (da !== null && db === null) return -1;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

/**
 * The offer to show next: the first in queue order that this driver hasn't
 * already handled (accepted, declined, timed out, seen withdrawn) and that
 * still has at least MIN_OFFER_SHOW_MS of its request window left. Null when
 * there's nothing to show.
 */
export function nextOffer<T extends QueueableOffer>(
  offers: readonly T[],
  handled: ReadonlySet<string>,
  now: number,
): T | null {
  for (const offer of orderOffers(offers)) {
    if (handled.has(offer.rideId)) continue;
    if (Date.parse(offer.expiresAt) - now < MIN_OFFER_SHOW_MS) continue;
    return offer;
  }
  return null;
}

/** When the offer shown at `shownAt` times out: its countdown, or the request's own end if sooner. */
export function offerDeadline(shownAt: number, offerSeconds: number, expiresAt: string): number {
  const own = shownAt + Math.max(1, offerSeconds) * 1000;
  const requestEnds = Date.parse(expiresAt);
  return Number.isFinite(requestEnds) ? Math.min(own, requestEnds) : own;
}

/**
 * Whether the offer on screen should stay: it is still in the latest list
 * from the server (not taken, cancelled or expired), the server hasn't said
 * it was withdrawn, and its countdown hasn't run out.
 */
export function isOfferLive(
  current: { rideId: string; deadline: number },
  offers: readonly { rideId: string }[],
  withdrawn: ReadonlySet<string>,
  now: number,
): "live" | "gone" | "timedOut" {
  if (withdrawn.has(current.rideId) || !offers.some((o) => o.rideId === current.rideId)) return "gone";
  if (now >= current.deadline) return "timedOut";
  return "live";
}

/** "Shared · 1 seat", "Ride alone". */
export function offerKindLabel(type: "LONE" | "SHARED", seats: number): string {
  return type === "LONE" ? "Ride alone" : `Shared · ${seats} seat${seats === 1 ? "" : "s"}`;
}

/** "4 min · 1.2 km" / "under 1 min · 300 m"; null pieces are left out. */
export function minutesAndDistance(minutes: number | null, meters: number | null): string {
  const parts: string[] = [];
  if (minutes !== null) parts.push(minutes < 1 ? "under 1 min" : `${Math.round(minutes)} min`);
  if (meters !== null) parts.push(meters < 1000 ? `${Math.max(50, Math.round(meters / 50) * 50)} m` : `${(meters / 1000).toFixed(1)} km`);
  return parts.join(" · ");
}
