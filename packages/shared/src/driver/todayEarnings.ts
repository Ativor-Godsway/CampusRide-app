/**
 * "Today GH₵17.50 · 2 trips" on the driver's Home: the driver's share of
 * the trips they completed today, by the phone's own clock. Worked out from
 * the completed-trip history the app already loads (GET /driver/rides/history),
 * which has no "today" total of its own.
 */
export interface CompletedTripEarning {
  /** When the trip was completed (ISO). */
  completedAt: string;
  /** The driver's share of it, pesewas. */
  driverGrossPesewas: number;
}

export function todayEarnings(
  trips: readonly CompletedTripEarning[],
  now: Date = new Date(),
): { pesewas: number; trips: number } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  let pesewas = 0;
  let count = 0;
  for (const trip of trips) {
    const at = new Date(trip.completedAt);
    if (at.getFullYear() !== y || at.getMonth() !== m || at.getDate() !== d) continue;
    pesewas += trip.driverGrossPesewas;
    count += 1;
  }
  return { pesewas, trips: count };
}
