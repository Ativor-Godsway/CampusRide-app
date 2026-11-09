import { recentTripsSince } from "@rida/shared";
import { getDriverRideHistory } from "@rida/mobile-shared";

/**
 * The driver's trip history, shared by Home's "Today", the trip-complete card
 * and Earnings (one cache entry). Only the last 7 days of trips are fetched
 * (recentTripsSince); the summary is still all time. Older trips stay on
 * the server (and on the admin site), the app just doesn't list them.
 */
export const driverRideHistoryQueryKey = ["driverRideHistory"];

export function fetchRecentRideHistory() {
  return getDriverRideHistory({ since: recentTripsSince() });
}
