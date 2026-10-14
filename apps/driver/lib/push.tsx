import { useCallback } from "react";
import { useRouter } from "expo-router";
import { pushTapTarget, type PushData } from "@rida/shared";
import { PushNotifications } from "@rida/mobile-shared";

/**
 * Push notifications in the driver app (rules: @rida/shared push/notifications).
 *
 * Tap: a new request opens Home, where its offer pops up while it's still
 * open; a rider cancelling opens that trip's screen (which goes Home itself
 * if the trip has ended). While the app is open, a request doesn't show over
 * Home (the offer pop-up is already there with its own sound) and a
 * cancellation doesn't show over the trip screen.
 */
export function DriverPushNotifications() {
  const router = useRouter();

  const onOpen = useCallback(
    (data: PushData) => {
      if (pushTapTarget(data.kind) === "trip") router.navigate(`/ride/${data.rideId}`);
      else router.navigate("/(tabs)");
    },
    [router],
  );

  return (
    <PushNotifications
      app="driver"
      onOpen={onOpen}
      showInForeground={(data, pathname) =>
        data.kind === "RIDE_REQUEST" ? pathname !== "/" : !pathname.startsWith("/ride/")
      }
    />
  );
}
