import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { shouldKeepScreenAwake } from "@rida/shared";
import { useAuth } from "@rida/mobile-shared";
import { useDriverPresence } from "./presence";

/** Its own tag, so going offline never releases a trip's wake lock (lib/tripRuntime) or the other way round. */
const KEEP_AWAKE_TAG = "campusride-online";

/**
 * Keeps the screen on while the driver is online (offers pop up, their
 * position is reported; there are no push notifications yet) and lets it
 * sleep again as soon as they go offline or sign out. expo-keep-awake works
 * in Expo Go. Mounted once in the root layout; renders nothing.
 */
export function OnlineKeepAwake() {
  const { user } = useAuth();
  const { isOnline } = useDriverPresence();
  const awake = shouldKeepScreenAwake({ signedInAsDriver: user?.role === "DRIVER", isOnline });

  useEffect(() => {
    if (!awake) return;
    void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      void deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [awake]);

  return null;
}
