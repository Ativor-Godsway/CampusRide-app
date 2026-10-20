import { Redirect } from "expo-router";
import { DesignGalleryScreen } from "@rida/mobile-shared";

/**
 * Dev-only: every design-system component and text style, to compare with
 * docs/design-system.md. Opened from Account in a dev build; a production
 * build (and any deep link to it) goes back to the start screen.
 */
export default function DesignGalleryRoute() {
  if (!__DEV__) return <Redirect href="/" />;
  return <DesignGalleryScreen />;
}
