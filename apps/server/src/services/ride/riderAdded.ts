import type { PrismaClient, RidePassenger, Ride } from "@prisma/client";
import { indexRoutes, onboardAddNotice, previewAddRider, type PassengerStatus, type PathPoint } from "@rida/shared";
import { emitRideEvent, emitToRider } from "../../realtime/rideSocket";
import { notifyRider } from "../push/notify";
import { approximatePins } from "../places/approximatePins";
import { pinFieldsOf } from "../../routes/ridePins";
import { getActivePlaces } from "../places/placeCache";
import { getStoredZoneRoutes, getZoneMap } from "../zones/zoneCache";
import type { AddCandidate } from "./assembly";
import { closeOffer, reofferToDriver } from "./dispatch";
import { DetourTooLongError } from "./errors";

/**
 * What adding a rider to a car shares, whoever does it: the driver's "Add"
 * (POST /rides/:id/add-passenger) and the moving-car step's auto-add
 * (services/ride/movingFirst.ts). The detour check is the same one the add
 * preview shows; the announcements are the same events and pushes.
 */

export interface DetourOutcome {
  /** Riders on board, by seat id: the delay the new rider adds to them. */
  onboardDelaySeconds: Record<string, number>;
  requestPickupZoneId: string | null;
  requestRiderId: string | null;
}

/**
 * addRiderToCar's checkCar: refuses (DetourTooLongError) a rider who'd delay
 * someone on board past the limit, and records what the announcements need.
 */
export async function detourCheck(prisma: PrismaClient, requestRideId: string, from: PathPoint | null) {
  const [zones, storedRoutes, places] = await Promise.all([getZoneMap(prisma), getStoredZoneRoutes(prisma), getActivePlaces(prisma)]);
  const outcome: DetourOutcome = { onboardDelaySeconds: {}, requestPickupZoneId: null, requestRiderId: null };
  const checkCar = ({ passengers, candidate }: { anchor: Ride; passengers: readonly RidePassenger[]; candidate: AddCandidate }) => {
    outcome.requestPickupZoneId = candidate.pickupZoneId;
    outcome.requestRiderId = candidate.riderId;
    const preview = previewAddRider({
      passengers: passengers.map((p) => ({
        id: p.id,
        pickupZoneId: p.pickupZoneId,
        dropoffZoneId: p.dropoffZoneId,
        lockedFare: p.lockedFare,
        status: p.status as PassengerStatus,
        ...pinFieldsOf(p),
      })),
      candidate: {
        requestRideId,
        pickupZoneId: candidate.pickupZoneId,
        dropoffZoneId: candidate.dropoffZoneId,
        farePesewas: candidate.quotedFare,
        ...approximatePins(candidate, zones, places),
      },
      zones: [...zones.values()],
      routes: indexRoutes(storedRoutes),
      from,
    });
    if (preview && !preview.withinDetourLimit) throw new DetourTooLongError(preview.maxOnboardDelaySeconds);
    outcome.onboardDelaySeconds = preview?.onboardDelaySeconds ?? {};
  };
  return { checkCar, outcome, zones };
}

/**
 * A rider just joined this car: the request closes for every other driver,
 * the rider's app follows the merge, they're told (a "Driver found" push, or
 * `riderPush` instead), the driver's lists are worked out again, and riders
 * already on board hear about the detour.
 */
export function announceRiderAdded(
  prisma: PrismaClient,
  added: {
    carId: string;
    driverUserId: string;
    requestRideId: string;
    outcome: DetourOutcome;
    passengers: readonly RidePassenger[];
    /** Instead of DRIVER_ASSIGNED (the moving-car step sends JOINED_CAR). */
    riderPush?: () => void;
  },
): void {
  const { carId, driverUserId, requestRideId, outcome } = added;
  if (outcome.requestPickupZoneId) closeOffer(prisma, { id: requestRideId, pickupZoneId: outcome.requestPickupZoneId, driverId: driverUserId }, "TAKEN");
  // #7 merged-rider reach: the absorbed request is now CANCELLED /
  // MERGED_INTO_ANOTHER_RIDE. That rider's app is still tracking it, so tell
  // its room — with the reason and this car, which the client follows.
  emitRideEvent(requestRideId, "ride:status", {
    rideId: requestRideId,
    status: "CANCELLED",
    cancelReason: "MERGED_INTO_ANOTHER_RIDE",
    mergedIntoRideId: carId,
  });
  if (added.riderPush) added.riderPush();
  else if (outcome.requestRiderId) notifyRider(prisma, outcome.requestRiderId, "DRIVER_ASSIGNED", carId, { driverUserId });
  // One seat fewer: this driver's lists are worked out again.
  reofferToDriver(prisma, driverUserId);
  // Riders already in the car hear about the detour.
  for (const p of added.passengers) {
    const delay = outcome.onboardDelaySeconds[p.id];
    if (p.status !== "PICKED_UP" || delay === undefined) continue;
    emitToRider(p.riderId, "ride:car_notice", {
      rideId: carId,
      message: onboardAddNotice(delay),
      delayMinutes: Math.max(1, Math.round(delay / 60)),
    });
  }
}
