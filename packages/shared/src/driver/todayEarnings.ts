import { periodEarnings, type EarningTrip } from "./periodEarnings";

/**
 * "Today GH₵17 · 2 trips" — on the driver's Home pill, the trip-complete card
 * and the Earnings tab alike: today's after-commission earnings (the sum of
 * the driver's shares, earningsTotals) and how many trips, by the phone's
 * own clock. From the completed-trip history the app already loads.
 */
export function todayEarnings(
  trips: readonly EarningTrip[],
  now: Date = new Date(),
): { pesewas: number; trips: number } {
  const today = periodEarnings(trips, "today", now);
  return { pesewas: today.netPesewas, trips: today.trips };
}
