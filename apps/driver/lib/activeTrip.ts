import { useQuery } from "@tanstack/react-query";
import { driverTripHref, driverTripStatusLine } from "@rida/shared";
import { getDriverActiveRide, useAuth, type RideWithZones } from "@rida/mobile-shared";
import { finishedLocally, overlayPassengers, useTripActions } from "./tripActions";

/**
 * The driver's current trip (MATCHED / ARRIVED / IN_PROGRESS), or null.
 * Same cache entry as Home's own query, so the banner, Home and the trip
 * screen always agree. Refetched on foreground (installAppStateFocusManager).
 */
export const driverActiveRideQueryKey = ["driverActiveRide"] as const;

/**
 * The driver's current trip. A trip this device has just finished (everyone
 * dropped off, not yet confirmed by the server) already counts as over, so
 * Home and the banner clear the moment the last drop-off is done — pass
 * `includeFinished` for the trip screen, which shows the summary for it.
 */
export function useDriverActiveTrip(refetchIntervalMs = 15_000, options: { includeFinished?: boolean } = {}) {
  const { isAuthenticated, user } = useAuth();
  // Re-render when this device's actions change what "finished" means.
  const actions = useTripActions();
  const query = useQuery<RideWithZones | null>({
    queryKey: driverActiveRideQueryKey,
    queryFn: getDriverActiveRide,
    enabled: isAuthenticated && user?.role === "DRIVER" && Boolean(user?.driver?.isApproved),
    refetchInterval: refetchIntervalMs,
  });
  const ride = query.data;
  const hidden = Boolean(ride && !options.includeFinished && finishedLocally(ride));
  void actions;
  return hidden ? { ...query, data: null } : query;
}

/** Where "back to my trip" leads: the trip screen, for every kind of trip. */
export function tripHref(ride: RideWithZones): `/ride/${string}` {
  return driverTripHref(ride);
}

/** The banner's line (see driverTripStatusLine in @rida/shared). */
export function tripStatusLine(ride: RideWithZones): string {
  return driverTripStatusLine({
    type: ride.type,
    status: ride.status,
    pickupZoneName: ride.pickupZone.name,
    dropoffZoneName: ride.dropoffZone.name,
    // With this device's not-yet-confirmed steps, so it changes on the slide.
    passengerStatuses: overlayPassengers(ride.id, ride.passengers).map((p) => p.status),
  });
}

/**
 * Trips whose screen has already been opened this session. Home opens a
 * newly matched trip once; a driver who then steps back isn't bounced
 * straight back (the active-trip banner is how they return). Shared with
 * "Requests near you", which opens the trip itself after a claim.
 */
const openedTripIds = new Set<string>();

export function markTripOpened(rideId: string): void {
  openedTripIds.add(rideId);
}

export function wasTripOpened(rideId: string): boolean {
  return openedTripIds.has(rideId);
}
