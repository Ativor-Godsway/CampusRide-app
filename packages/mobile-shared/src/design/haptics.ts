import * as Haptics from "expo-haptics";

/**
 * Central haptics helper — every haptic in both apps goes through here so
 * feedback can be toggled globally (e.g. a future account setting) without
 * touching call sites. All calls are fire-and-forget and swallow errors
 * (haptics are unavailable on some devices/simulators — never worth a crash).
 */
let enabled = true;

export const haptics = {
  setEnabled(value: boolean) {
    enabled = value;
  },
  /** Primary actions, keypad keys, tab switches. */
  light() {
    if (!enabled) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  /** Selection changes (ride type, payment method, chips, stars). */
  selection() {
    if (!enabled) return;
    void Haptics.selectionAsync().catch(() => {});
  },
  /** Completed moments: OTP verified, payment confirmed. */
  success() {
    if (!enabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  /** Failed verification, payment failure. */
  error() {
    if (!enabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
  },
};
