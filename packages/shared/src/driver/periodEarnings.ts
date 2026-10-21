import { splitFare } from "../pricing/pricing";

/**
 * The driver's Earnings tab, for "Today" and "This week": what they earned
 * after commission, as GET /driver/rides/history sums it for all time
 * (net = the driver's gross share − the 15% commission recorded on cash
 * trips). The history has no per-trip payment method; CampusRide is
 * cash-only at launch, so every trip is counted as cash. Phone's own clock.
 */
export interface EarningTrip {
  completedAt: string;
  /** The rider fare(s), pesewas. */
  facePesewas: number;
  /** The driver's share (85%), pesewas. */
  driverGrossPesewas: number;
}

export interface EarningsTotals {
  trips: number;
  grossPesewas: number;
  commissionPesewas: number;
  /** gross − commission: may go negative, never clamped (as the server's summary). */
  netPesewas: number;
}

export interface EarningsDay extends EarningsTotals {
  /** "Mon" … "Sun". */
  label: string;
  /** Midnight at the start of the day (epoch ms). */
  start: number;
  isToday: boolean;
}

const LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function startOfDay(value: Date | string | number): number {
  const d = new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function totals(trips: readonly EarningTrip[]): EarningsTotals {
  let gross = 0;
  let commission = 0;
  for (const t of trips) {
    gross += t.driverGrossPesewas;
    commission += splitFare(t.facePesewas).commission;
  }
  return {
    trips: trips.length,
    grossPesewas: gross,
    commissionPesewas: commission,
    netPesewas: gross - commission,
  };
}

/** This week, Monday to Sunday, one entry a day (days still to come are empty). */
export function weekEarnings(trips: readonly EarningTrip[], now: Date = new Date()): EarningsDay[] {
  const today = startOfDay(now);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return LABELS.map((label, i) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + i);
    const start = day.getTime();
    return {
      label,
      start,
      isToday: start === today,
      ...totals(trips.filter((t) => startOfDay(t.completedAt) === start)),
    };
  });
}

/** Today's, or this week's (Monday on), totals. */
export function periodEarnings(
  trips: readonly EarningTrip[],
  period: "today" | "week",
  now: Date = new Date(),
): EarningsTotals {
  const days = weekEarnings(trips, now);
  const inPeriod = period === "today" ? days.filter((d) => d.isToday) : days;
  return inPeriod.reduce<EarningsTotals>(
    (sum, d) => ({
      trips: sum.trips + d.trips,
      grossPesewas: sum.grossPesewas + d.grossPesewas,
      commissionPesewas: sum.commissionPesewas + d.commissionPesewas,
      netPesewas: sum.netPesewas + d.netPesewas,
    }),
    { trips: 0, grossPesewas: 0, commissionPesewas: 0, netPesewas: 0 },
  );
}
