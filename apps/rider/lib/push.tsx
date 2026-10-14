import { useCallback } from "react";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { pushTapTarget, type PushData } from "@rida/shared";
import { PushNotifications, activeRideQueryKey, getActiveRide } from "@rida/mobile-shared";
import { activeRideParams, claimLaunchRideCheck } from "./activeRide";

/**
 * Push notifications in the rider app (rules: @rida/shared push/notifications).
 *
 * Tap: live ride news opens the ride screen (or Home if the ride has ended
 * since), a finished trip opens Rides, a cancelled pickup opens Home.
 * While the app is open, nothing shows over the ride screen — it already
 * shows the same news live.
 */
export function RiderPushNotifications() {
  const router = useRouter();
  const queryClient = useQueryClient();

  const onOpen = useCallback(
    async (data: PushData) => {
      // The tap decides the first screen, not the launch-time ride check.
      claimLaunchRideCheck();
      const target = pushTapTarget(data.kind);
      if (target === "rides") return router.navigate("/(tabs)/rides");
      if (target === "trip") {
        const ride = await queryClient
          .fetchQuery({ queryKey: activeRideQueryKey, queryFn: getActiveRide, staleTime: 0 })
          .catch(() => null);
        if (ride)
          return router.navigate({ pathname: "/ride/type", params: activeRideParams(ride) });
      }
      router.navigate("/(tabs)");
    },
    [router, queryClient],
  );

  return (
    <PushNotifications
      app="rider"
      onOpen={(data) => void onOpen(data)}
      showInForeground={(_data, pathname) => pathname !== "/ride/type"}
    />
  );
}
