/**
 * Whether the driver app keeps the phone's screen on. While a driver is
 * online, offers pop up and their position is reported — and there are no
 * push notifications or background location yet (they come with the Android
 * pilot build), so a screen that locks itself means missed offers. Released
 * the moment they go offline or sign out, so the phone isn't kept awake for
 * nothing. (A trip keeps its own wake lock as well, separately.)
 */
export function shouldKeepScreenAwake(input: { signedInAsDriver: boolean; isOnline: boolean }): boolean {
  return input.signedInAsDriver && input.isOnline;
}
