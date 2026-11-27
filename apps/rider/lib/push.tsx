import { useCallback, useEffect } from "react";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { SCHEDULE_COMING_ACTION, SCHEDULE_REMINDER_CATEGORY, pushTapTarget, type PushData } from "@rida/shared";
import { PushNotifications, activeRideQueryKey, getActiveRide, myScheduledRideQueryKey, sayImComing } from "@rida/mobile-shared";
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

  // The scheduled ride reminder's "I'm coming" button (rides/scheduled.ts).
  useEffect(() => {
    void Notifications.setNotificationCategoryAsync(SCHEDULE_REMINDER_CATEGORY, [
      { identifier: SCHEDULE_COMING_ACTION, buttonTitle: "I'm coming", options: { opensAppToForeground: true } },
    ]).catch(() => undefined);
  }, []);

  const onAction = useCallback(
    (actionId: string, data: PushData) => {
      claimLaunchRideCheck();
      if (actionId !== SCHEDULE_COMING_ACTION || data.kind !== "SCHEDULE_REMINDER") return;
      void sayImComing(data.rideId)
        .then(() => queryClient.invalidateQueries({ queryKey: myScheduledRideQueryKey }))
        .catch(() => undefined);
      router.navigate("/(tabs)");
    },
    [router, queryClient],
  );

  return (
    <PushNotifications
      app="rider"
      onOpen={(data) => void onOpen(data)}
      onAction={onAction}
      showInForeground={(_data, pathname) => pathname !== "/ride/type"}
    />
  );
}
