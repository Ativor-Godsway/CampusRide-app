import { useEffect, useState } from "react";
import { useFonts } from "expo-font";
import { Figtree_400Regular } from "@expo-google-fonts/figtree/400Regular";
import { Figtree_500Medium } from "@expo-google-fonts/figtree/500Medium";
import { Figtree_600SemiBold } from "@expo-google-fonts/figtree/600SemiBold";
import { Figtree_700Bold } from "@expo-google-fonts/figtree/700Bold";
import { Figtree_800ExtraBold } from "@expo-google-fonts/figtree/800ExtraBold";
import { hideSplashScreen } from "./splash";

/**
 * Figtree, the one type family in docs/design-system.md, as a family name
 * per weight: `fontFamily: fonts.bold`. Each weight is its own family, so
 * don't also set `fontWeight` (Android would fake-bold it).
 *
 * The same five files are embedded in the store build by the expo-font
 * config plugin (each app's app.json) AND loaded at runtime by
 * useAppFonts(), which is what makes these names work in Expo Go too. On
 * Android the embedded file names equal these names; on iOS the runtime load
 * maps them onto the embedded font.
 */
export const fonts = {
  regular: "Figtree_400Regular",
  medium: "Figtree_500Medium",
  semibold: "Figtree_600SemiBold",
  bold: "Figtree_700Bold",
  extrabold: "Figtree_800ExtraBold",
} as const;

const fontFiles: Record<(typeof fonts)[keyof typeof fonts], number> = {
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
  Figtree_800ExtraBold,
};

/** How long the splash waits for Figtree before the app opens on the system font anyway. */
const FONT_WAIT_MS = 4000;

/**
 * Once the app may render, how long before the splash is hidden anyway if
 * the root view's onLayout hasn't hidden it (a first render that failed).
 */
export const SPLASH_FALLBACK_MS = 1500;

/**
 * Loads Figtree. Returns true when the app may render. The root layout
 * holds the splash at module scope (holdSplashScreen) and hides it from its
 * root view's onLayout (hideSplashScreen) once this is true, so the first
 * screen is already laid out when the splash goes.
 *
 * A font that fails to load, or takes longer than FONT_WAIT_MS, never keeps
 * the app on the splash: it opens on the system font instead. Nor does a
 * first render that never lays out: SPLASH_FALLBACK_MS later, the splash
 * goes regardless.
 */
export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(fontFiles);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), FONT_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  const ready = loaded || error != null || timedOut;

  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(hideSplashScreen, SPLASH_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  return ready;
}
