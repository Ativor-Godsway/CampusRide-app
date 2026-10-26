import * as SplashScreen from "expo-splash-screen";

/**
 * The native splash (each app's app.json → expo-splash-screen plugin: the
 * white CampusRide logo and name from assets/splash-icon.png, on green for
 * the rider app and near-black for the driver app) stays up until the fonts are in
 * and the first screen is laid out under it, so it gives way straight to the
 * app with no blank frame between.
 */

/** The splash's fade into the first screen. iOS only; Android hides at once. */
export const SPLASH_FADE_MS = 250;

/** Call once at module scope in the root layout, before anything renders. */
export function holdSplashScreen(): void {
  SplashScreen.setOptions({ fade: true, duration: SPLASH_FADE_MS });
  void SplashScreen.preventAutoHideAsync();
}

/**
 * The root view's `onLayout` (the root view only renders once the fonts are
 * ready). Safe to call more than once.
 */
export function hideSplashScreen(): void {
  SplashScreen.hide();
}
