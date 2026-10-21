/**
 * The ONE rule for a driver's earnings, used by the server's all-time summary
 * (GET /driver/rides/history) and by the driver app's Today / This week:
 *
 * - Gross = the sum of the FARES riders paid (`facePesewas`).
 * - Commission = CampusRide's 15% of those fares (fare − driver share).
 * - After commission = the sum of the driver's 85% SHARES — the "You earn"
 *   amounts. The commission is taken out ONCE: the share already excludes it.
 *
 * `driverGrossPesewas` is the API's (older) name for the driver's 85% share
 * of one trip; it is not a gross. Phone's own clock for days.
 */
export interface EarningTrip {
  completedAt: string;
  /** The rider fare(s) for the trip, pesewas (all riders on a shared trip). */
  facePesewas: number;
  /** The driver's 85% share of that fare ("You earn"), pesewas. */
  driverGrossPesewas: number;
}

export interface EarningsTotals {
  trips: number;
  /** Fares paid, pesewas. */
  grossPesewas: number;
  /** CampusRide's 15% of them, pesewas. */
  commissionPesewas: number;
  /** What the driver keeps: gross − commission = the sum of their shares. */
  netPesewas: number;
}

/** Gross, commission and after-commission for any set of trips (all time, a day, a week). */
export function earningsTotals(trips: readonly EarningTrip[]): EarningsTotals {
  let gross = 0;
  let net = 0;
  for (const t of trips) {
    gross += t.facePesewas;
    net += t.driverGrossPesewas;
  }
  return {
    trips: trips.length,
    grossPesewas: gross,
    commissionPesewas: gross - net,
    netPesewas: net,
  };
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
      ...earningsTotals(trips.filter((t) => startOfDay(t.completedAt) === start)),
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
