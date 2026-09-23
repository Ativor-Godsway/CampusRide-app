import { Alert, Linking, Platform } from "react-native";

/**
 * Phase 4: placing a call and handing off to a maps app.
 *
 * Both are intentionally thin wrappers over `Linking.openURL`. Calls use a
 * plain `tel:` link to the other party's real number — number masking (a
 * relay that hides both sides) needs a telephony provider and per-ride
 * ephemeral numbers, which is its own project. See the Phase 4 notes.
 */

/** Strips spaces, dashes and brackets so `tel:` gets a clean dial string. */
function normalizeForDial(phone: string): string {
  return phone.replace(/[\s()-]/g, "");
}

/**
 * Opens the phone dialler for `phone`.
 *
 * Uses `tel:` rather than `telprompt:` so the behaviour is the same on both
 * platforms, and pre-fills the dialler rather than dialling outright — the
 * caller gets a chance to see who they are about to ring.
 */
export async function callPhone(phone: string | null | undefined, who = "them"): Promise<void> {
  if (!phone) {
    Alert.alert("No phone number", `We don't have a number for ${who} yet.`);
    return;
  }

  const url = `tel:${normalizeForDial(phone)}`;
  try {
    await Linking.openURL(url);
  } catch {
    // Simulators and tablets often have no dialler at all; surfacing the
    // number means the person can still act on it.
    Alert.alert("Couldn't open the dialler", `You can call ${who} on ${phone}.`);
  }
}

export interface DirectionsTarget {
  latitude: number;
  longitude: number;
  /** Shown as the destination name in the maps app, e.g. the zone name. */
  label?: string;
}

/**
 * Opens the platform's maps app with directions to `target`.
 *
 * iOS gets Apple Maps and Android gets Google Maps via each platform's
 * documented URL scheme. The `geo:` fallback lets Android hand off to
 * whatever maps app the driver actually has installed rather than assuming
 * Google Maps is present.
 */
export async function openDirections(target: DirectionsTarget): Promise<void> {
  const { latitude, longitude, label } = target;
  const coords = `${latitude},${longitude}`;
  const encodedLabel = encodeURIComponent(label ?? "Destination");

  const primary =
    Platform.OS === "ios"
      ? // `dirflg=d` asks for driving directions.
        `http://maps.apple.com/?daddr=${coords}&q=${encodedLabel}&dirflg=d`
      : `google.navigation:q=${coords}`;

  const fallback =
    Platform.OS === "ios"
      ? `https://maps.apple.com/?daddr=${coords}`
      : `geo:${coords}?q=${coords}(${encodedLabel})`;

  try {
    await Linking.openURL(primary);
  } catch {
    try {
      await Linking.openURL(fallback);
    } catch {
      Alert.alert("Couldn't open maps", "No maps app is available on this device.");
    }
  }
}
