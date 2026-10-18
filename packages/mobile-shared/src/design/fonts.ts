import { useEffect, useState } from "react";
import { useFonts } from "expo-font";
import { SplashScreen } from "expo-router";
import { Figtree_400Regular } from "@expo-google-fonts/figtree/400Regular";
import { Figtree_500Medium } from "@expo-google-fonts/figtree/500Medium";
import { Figtree_600SemiBold } from "@expo-google-fonts/figtree/600SemiBold";
import { Figtree_700Bold } from "@expo-google-fonts/figtree/700Bold";
import { Figtree_800ExtraBold } from "@expo-google-fonts/figtree/800ExtraBold";

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
 * Loads Figtree and hides the splash screen once it is ready. Returns true
 * when the app may render. The root layout calls
 * `SplashScreen.preventAutoHideAsync()` at module scope so the splash stays
 * up until then.
 *
 * A font that fails to load, or takes longer than FONT_WAIT_MS, never keeps
 * the app on the splash: it opens on the system font instead.
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
    if (ready) void SplashScreen.hideAsync();
  }, [ready]);

  return ready;
}
