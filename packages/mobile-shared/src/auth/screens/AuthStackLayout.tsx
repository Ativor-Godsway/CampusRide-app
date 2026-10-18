import { Redirect, Stack } from "expo-router";
import { useAuth } from "../AuthContext";

/**
 * Layout for an app's `auth/` screens (phone number, code, sign-up): use it
 * as `app/auth/_layout.tsx`. The sign-in screens are one group in the
 * navigation history, and the moment a session exists the whole group is
 * replaced by the start screen — so it is gone from the history.
 *
 * Without this, signing in left the phone-number screen at the bottom of
 * the history, under Home. "Back to Home" after a trip (which returns to
 * the bottom of the history), the driver's ← during a trip, or Android's
 * back button on Home then showed the sign-in screen: the person looked
 * signed out though their session was fine. And any path that lands a
 * signed-in person here bounces straight back.
 */
export function AuthStackLayout() {
  const { isLoading, isAuthenticated } = useAuth();
  if (!isLoading && isAuthenticated) return <Redirect href="/" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
