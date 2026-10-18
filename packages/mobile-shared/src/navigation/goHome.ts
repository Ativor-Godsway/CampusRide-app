import type { useRouter } from "expo-router";

/**
 * Back to the Home tab from anywhere above it (a trip, a trip summary):
 * everything above the tabs is closed, or — if the tabs aren't in the
 * history at all, say the trip was opened from a notification — the
 * current screen is replaced by them.
 *
 * Never `router.dismissAll()`: that returns to the BOTTOM of the history,
 * which is not necessarily Home. After signing in it used to be the
 * phone-number screen, so "Back to Home" looked like being signed out.
 */
export function goHome(router: Pick<ReturnType<typeof useRouter>, "dismissTo">): void {
  router.dismissTo("/(tabs)");
}
