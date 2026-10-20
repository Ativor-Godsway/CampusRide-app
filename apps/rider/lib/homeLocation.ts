import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import * as Location from "expo-location";
import { REVIEW_DEMO_POSITION, isInServiceArea } from "@rida/shared";
import { useAuth } from "@rida/mobile-shared";

export type HomeLocation =
  | { state: "loading" }
  /** On campus: the map centres on them, with the location dot. */
  | { state: "here"; coords: { latitude: number; longitude: number } }
  /** Location off or refused: the map shows campus, and the sheet asks. */
  | { state: "off" }
  /** Off campus: the map shows campus, and the sheet says pickups are inside UG Legon. */
  | { state: "outside" };

/** A last-known fix this recent is good enough to centre the map. */
const LAST_KNOWN_MAX_AGE_MS = 2 * 60_000;

/**
 * Where the rider is, for Home's map. Asks for location once (the system
 * prompt, the first time); `turnOn` asks again, or opens Settings when the
 * phone won't ask any more. Never throws.
 */
export function useHomeLocation(): { location: HomeLocation; turnOn: () => void } {
  const isReviewDemo = Boolean(useAuth().user?.isReviewDemo);
  const [location, setLocation] = useState<HomeLocation>({ state: "loading" });
  const [canAskAgain, setCanAskAgain] = useState(true);

  const locate = useCallback(async () => {
    // An App Store / Google Play reviewer is "on campus" wherever they are.
    if (isReviewDemo) {
      setLocation({ state: "here", coords: REVIEW_DEMO_POSITION });
      return;
    }
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      setCanAskAgain(permission.canAskAgain);
      if (permission.status !== "granted") {
        setLocation({ state: "off" });
        return;
      }
      const fix =
        (await Location.getLastKnownPositionAsync({ maxAge: LAST_KNOWN_MAX_AGE_MS })) ??
        (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }));
      const coords = { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
      setLocation(isInServiceArea(coords) ? { state: "here", coords } : { state: "outside" });
    } catch {
      setLocation({ state: "off" });
    }
  }, [isReviewDemo]);

  useEffect(() => {
    void locate();
  }, [locate]);

  // Back from Settings (or another app): look again if location was off.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && location.state === "off") void locate();
    });
    return () => sub.remove();
  }, [location.state, locate]);

  const turnOn = useCallback(() => {
    if (canAskAgain) void locate();
    else void Linking.openSettings();
  }, [canAskAgain, locate]);

  return { location, turnOn };
}
