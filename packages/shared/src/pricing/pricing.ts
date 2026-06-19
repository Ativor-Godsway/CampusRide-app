/**
 * CampusRide pricing engine — pure functions, no side effects.
 * All monetary values are in INTEGER PESEWAS (GHS 1 = 100 pesewas).
 * Never use floats for money.
 */

// ─── Config ──────────────────────────────────────────────────────────────────

export const PRICING = {
  LONE_FARE: 1500,
  LONE_OCCUPANCY: 1,

  MIN_SHARED_OCCUPANCY: 1,
  MAX_SHARED_OCCUPANCY: 4,

  /**
   * Flat per-rider fare for a SHARED ride — 500 pesewas regardless of final
   * occupancy. Keyed by occupancy (1–4) only so `getSharedFarePerRider`'s
   * signature and every call site stay unchanged; the value is the same at
   * every key on purpose, not a placeholder.
   */
  SHARED_FARES: { 1: 500, 2: 500, 3: 500, 4: 500 } as const,

  /**
   * Commission split: 15% platform, 85% driver.
   * Stored as integers to avoid float arithmetic: commission = round(total * PCT / BASE).
   */
  COMMISSION_PCT: 15,
  COMMISSION_BASE: 100,
} as const;

// ─── Error ────────────────────────────────────────────────────────────────────

export class InvalidOccupancyError extends Error {
  readonly occupancy: number;
  constructor(message: string, occupancy: number) {
    super(message);
    this.name = "InvalidOccupancyError";
    this.occupancy = occupancy;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Throws if occupancy is not exactly 1 (the only valid LONE occupancy). */
export function validateLoneOccupancy(occupancy: number): void {
  if (occupancy !== PRICING.LONE_OCCUPANCY) {
    throw new InvalidOccupancyError(
      `LONE ride requires exactly ${PRICING.LONE_OCCUPANCY} rider, got ${occupancy}`,
      occupancy,
    );
  }
}

/** Throws if shared occupancy is outside 1–4. */
export function validateSharedOccupancy(
  occupancy: number,
): asserts occupancy is 1 | 2 | 3 | 4 {
  if (
    !Number.isInteger(occupancy) ||
    occupancy < PRICING.MIN_SHARED_OCCUPANCY ||
    occupancy > PRICING.MAX_SHARED_OCCUPANCY
  ) {
    throw new InvalidOccupancyError(
      `Shared occupancy must be ${PRICING.MIN_SHARED_OCCUPANCY}–${PRICING.MAX_SHARED_OCCUPANCY}, got ${occupancy}`,
      occupancy,
    );
  }
}

// ─── Core fare functions ──────────────────────────────────────────────────────

/** LONE flat fare: 1500 pesewas. */
export function getLoneFare(): number {
  return PRICING.LONE_FARE;
}

/**
 * Per-rider fare for a SHARED ride — flat 500 pesewas, decoupled from final
 * occupancy. `occupancy` is still validated (1–4, the seat cap) and kept as
 * a parameter so every call site stays the same; it no longer affects the
 * returned amount.
 */
export function getSharedFarePerRider(occupancy: number): number {
  validateSharedOccupancy(occupancy);
  return PRICING.SHARED_FARES[occupancy];
}

/**
 * Total fare collected by the driver for a SHARED ride.
 * = perRiderFare(occupancy) × occupancy.
 */
export function getSharedTotalFare(occupancy: number): number {
  validateSharedOccupancy(occupancy);
  return getSharedFarePerRider(occupancy) * occupancy;
}

// ─── Split ────────────────────────────────────────────────────────────────────

export interface FareSplit {
  /** Platform commission (15%, rounded to nearest pesewa). */
  commission: number;
  /** Driver's net earnings. commission + driverShare === totalFare exactly. */
  driverShare: number;
}

/**
 * Splits a total fare 15% platform / 85% driver.
 * Commission is rounded to the nearest pesewa; driver receives the remainder.
 * Invariant: commission + driverShare === totalFare always holds exactly.
 */
export function splitFare(totalFare: number): FareSplit {
  // Integer arithmetic first to avoid float representation drift.
  const commission = Math.round(
    (totalFare * PRICING.COMMISSION_PCT) / PRICING.COMMISSION_BASE,
  );
  const driverShare = totalFare - commission;
  return { commission, driverShare };
}

// ─── Convenience combiners ────────────────────────────────────────────────────

export interface LoneRidePrice {
  fare: number;
  commission: number;
  driverShare: number;
  total: number;
}

export interface SharedRidePrice {
  farePerRider: number;
  total: number;
  commission: number;
  driverShare: number;
}

/** Full pricing for a LONE ride. Always 1 rider; no occupancy argument needed. */
export function priceLoneRide(): LoneRidePrice {
  const fare = getLoneFare();
  const { commission, driverShare } = splitFare(fare);
  return { fare, commission, driverShare, total: fare };
}

/**
 * Full pricing for a SHARED ride at the given final occupancy (1–4).
 * Throws InvalidOccupancyError for occupancy outside that range.
 */
export function priceSharedRide(occupancy: number): SharedRidePrice {
  validateSharedOccupancy(occupancy);
  const farePerRider = getSharedFarePerRider(occupancy);
  const total = getSharedTotalFare(occupancy);
  const { commission, driverShare } = splitFare(total);
  return { farePerRider, total, commission, driverShare };
}
