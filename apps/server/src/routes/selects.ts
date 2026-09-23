import { Prisma } from "@prisma/client";

/**
 * Explicit Prisma `select` shapes for the rider-facing read endpoints.
 *
 * These routes previously used `include`, which returns EVERY scalar column
 * on the model. That makes the API surface a mirror of the schema: any column
 * added later — an internal flag, an operational timestamp, a moderation
 * note — is published to clients the moment the migration lands, with no code
 * change and nothing to review. Listing fields explicitly inverts that: a new
 * column is private until someone deliberately adds it here.
 *
 * The shapes mirror the published contracts in packages/shared (types/ride.ts)
 * so the apps keep compiling against the same fields they already use.
 */

/** Zone fields the apps render (name/quadrant + map coordinates). */
export const zoneSelect = {
  id: true,
  name: true,
  quadrant: true,
  latitude: true,
  longitude: true,
} satisfies Prisma.ZoneSelect;

/**
 * Ride fields safe to return to a RIDER.
 *
 * Deliberately omits `driverShare`: it is the platform's fare split, not the
 * rider's business, and nothing in either app reads it off a ride object (the
 * driver app gets `driverSharePesewas` from POST /rides/:id/complete instead).
 */
export const riderRideSelect = {
  id: true,
  riderId: true,
  driverId: true,
  type: true,
  status: true,
  source: true,
  pickupZoneId: true,
  dropoffZoneId: true,
  occupancy: true,
  fareTotal: true,
  paymentStatus: true,
  paymentMethod: true,
  cancelReason: true,
  mergedIntoRideId: true,
  createdAt: true,
  departedAt: true,
  completedAt: true,
  broadcastStartedAt: true,
  decisionStartedAt: true,
} satisfies Prisma.RideSelect;

/** Per-passenger fields, matching the shared RidePassenger contract. */
export const ridePassengerSelect = {
  id: true,
  rideId: true,
  riderId: true,
  pickupZoneId: true,
  dropoffZoneId: true,
  fareCharged: true,
  lockedFare: true,
  status: true,
} satisfies Prisma.RidePassengerSelect;

/** GET /rides/mine — ride plus its two zones. */
export const riderRideListSelect = {
  ...riderRideSelect,
  pickupZone: { select: zoneSelect },
  dropoffZone: { select: zoneSelect },
} satisfies Prisma.RideSelect;

/** GET /rides/:id — as above, plus the passenger manifest. */
export const riderRideDetailSelect = {
  ...riderRideListSelect,
  passengers: { select: ridePassengerSelect },
} satisfies Prisma.RideSelect;

/**
 * GET /me — the caller's own account.
 *
 * `updatedAt` is omitted as an internal bookkeeping column. The nested driver
 * profile is listed field by field for the same reason as above; approval and
 * online state are included because the driver app renders them.
 */
export const meSelect = {
  id: true,
  phone: true,
  name: true,
  role: true,
  createdAt: true,
  driver: {
    select: {
      id: true,
      userId: true,
      carMake: true,
      carModel: true,
      carColor: true,
      plate: true,
      photoUrl: true,
      isApproved: true,
      isOnline: true,
      currentZoneId: true,
    },
  },
} satisfies Prisma.UserSelect;
