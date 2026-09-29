import * as Haptics from "expo-haptics";

/**
 * Light touch feedback for the ride flow. Fire-and-forget: a phone without a
 * haptic engine (or with haptics off) must never turn a tap into an error.
 * Haptics aren't motion, so they don't follow Reduce Motion.
 */
export const haptics = {
  /** Picking an option (ride type, cancel reason). */
  selection: () => void Haptics.selectionAsync().catch(() => undefined),
  /** Something good happened (a driver accepted, a switch went through). */
  success: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
};
