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
 * Opens Google Maps with driving directions to the exact point in `target`
 * (an exact pickup pin, or a zone centre for a ride booked without one).
 *
 * - Android: Google Maps turn-by-turn (`google.navigation:`), then any maps
 *   app (`geo:`).
 * - iOS: the Google Maps app (`comgooglemaps://`) when it's installed, else
 *   Google Maps on the web (which opens the app if it is there), else Apple
 *   Maps — so a driver is never left without directions.
 *
 * Coordinates are sent with 6 decimals (~10 cm): the point, not a search by name.
 */
export async function openDirections(target: DirectionsTarget): Promise<void> {
  const { latitude, longitude, label } = target;
  const coords = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const encodedLabel = encodeURIComponent(label ?? "Destination");

  const attempts =
    Platform.OS === "ios"
      ? [
          `comgooglemaps://?daddr=${coords}&directionsmode=driving`,
          `https://www.google.com/maps/dir/?api=1&destination=${coords}&travelmode=driving`,
          `http://maps.apple.com/?daddr=${coords}&q=${encodedLabel}&dirflg=d`,
        ]
      : [
          `google.navigation:q=${coords}&mode=d`,
          `https://www.google.com/maps/dir/?api=1&destination=${coords}&travelmode=driving`,
          `geo:${coords}?q=${coords}(${encodedLabel})`,
        ];

  for (const url of attempts) {
    try {
      await Linking.openURL(url);
      return;
    } catch {
      // Not installed / not handled: try the next one.
    }
  }
  Alert.alert("Couldn't open maps", "No maps app is available on this device.");
}
