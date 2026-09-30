import { useQuery } from "@tanstack/react-query";
import { driverTripHref, driverTripStatusLine } from "@rida/shared";
import { getDriverActiveRide, useAuth, type RideWithZones } from "@rida/mobile-shared";

/**
 * The driver's current trip (MATCHED / ARRIVED / IN_PROGRESS), or null.
 * Same cache entry as Home's own query, so the banner, Home and the trip
 * screen always agree. Refetched on foreground (installAppStateFocusManager).
 */
export const driverActiveRideQueryKey = ["driverActiveRide"] as const;

export function useDriverActiveTrip() {
  const { isAuthenticated, user } = useAuth();
  return useQuery<RideWithZones | null>({
    queryKey: driverActiveRideQueryKey,
    queryFn: getDriverActiveRide,
    enabled: isAuthenticated && user?.role === "DRIVER" && Boolean(user?.driver?.isApproved),
    refetchInterval: 15_000,
  });
}

/** Where "back to my trip" leads (see driverTripHref in @rida/shared). */
export function tripHref(ride: RideWithZones): "/" | `/ride/${string}` {
  return driverTripHref(ride);
}

/** The banner's line (see driverTripStatusLine in @rida/shared). */
export function tripStatusLine(ride: RideWithZones): string {
  return driverTripStatusLine({
    type: ride.type,
    status: ride.status,
    pickupZoneName: ride.pickupZone.name,
    dropoffZoneName: ride.dropoffZone.name,
    passengerStatuses: ride.passengers.map((p) => p.status),
  });
}

/**
 * LONE trips whose screen has already been opened this session. Home opens
 * a newly matched LONE trip once; a driver who then steps back isn't bounced
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
