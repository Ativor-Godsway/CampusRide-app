import { useQuery } from "@tanstack/react-query";
import {
  activeRideQueryKey,
  getActiveRide,
  useAuth,
  useClearQueryCacheOnAccountChange,
  type ActiveRideSummary,
} from "@rida/mobile-shared";

/**
 * The rider's ride that is still going on, or null — the one source the
 * banner, the launch check and Choose a ride all read.
 *
 * Refetches when the app returns to the foreground (focusManager is wired to
 * AppState in app/_layout.tsx), and every 15s while a ride is active so the
 * banner's status keeps up. Not polled at all when there is no ride.
 */
export function useActiveRide() {
  const { isAuthenticated, user } = useAuth();
  return useQuery<ActiveRideSummary | null>({
    queryKey: activeRideQueryKey,
    queryFn: getActiveRide,
    enabled: isAuthenticated && user?.role === "RIDER",
    staleTime: 5_000,
    refetchInterval: (query) => (query.state.data ? 15_000 : false),
  });
}

/**
 * Once per signed-in session: if the rider opens (or reopens, after the app
 * was killed) the app mid-ride, the tabs layout takes them straight to it.
 * After that the banner is the way back — we don't yank them off a tab.
 */
let launchRideCheckDone = false;
export function claimLaunchRideCheck(): boolean {
  if (launchRideCheckDone) return false;
  launchRideCheckDone = true;
  return true;
}

/**
 * On a change of account: drop the previous rider's cached data (so their
 * ride can never become someone else's banner) and run the launch check
 * again for the new session.
 */
export function useResetCacheOnAccountChange() {
  useClearQueryCacheOnAccountChange(() => {
    launchRideCheckDone = false;
  });
}

/** Route params that reopen the ride screen on this ride, from the rider's own leg. */
export function activeRideParams(ride: ActiveRideSummary, extra: { openCancel?: boolean } = {}) {
  return {
    rideId: ride.id,
    pickupZoneId: ride.pickupZone.id,
    dropoffZoneId: ride.dropoffZone.id,
    pickupZoneName: ride.pickupZone.name,
    dropoffZoneName: ride.dropoffZone.name,
    pickupLat: String(ride.pickupZone.latitude),
    pickupLng: String(ride.pickupZone.longitude),
    dropoffLat: String(ride.dropoffZone.latitude),
    dropoffLng: String(ride.dropoffZone.longitude),
    ...(extra.openCancel ? { openCancel: "1" } : {}),
  };
}
