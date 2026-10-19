import * as Haptics from "expo-haptics";

/**
 * The spec's haptics (docs/design-system.md, "Motion and haptics").
 * Fire-and-forget: a phone without a haptic engine, or with haptics off, must
 * never turn a tap into an error. Haptics aren't motion, so they don't follow
 * Reduce Motion.
 */
export const haptics = {
  /** Chip or option change. */
  selection: () => void Haptics.selectionAsync().catch(() => undefined),
  /** Primary button press. */
  impactLight: () =>
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined),
  /** A slide-to-confirm completes. */
  impactMedium: () =>
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined),
  /** Trip complete, driver found. */
  success: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined),
  /** SOS opened, wrong code. */
  warning: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined),
  /** A request failed. */
  error: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined),
};
