import { useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { DRIVER_DEEP_LINK_POLICY } from "@rida/shared";
import {
  AuthProvider,
  TermsConfirmationGate,
  hideSplashScreen,
  holdSplashScreen,
  initMonitoring,
  installAppStateFocusManager,
  useAppFonts,
  useClearQueryCacheOnAccountChange,
  useDeepLinkGuard,
  withMonitoring,
} from "@rida/mobile-shared";
import { DriverPresenceProvider } from "../lib/presence";
import { DriverLocationProvider } from "../lib/location";
import { LocationDisclosureProvider } from "../components/LocationDisclosure";
// Defines the background location task as the app starts (the OS may deliver
// positions straight away).
import "../lib/backgroundLocation";
import { TripRuntime } from "../lib/tripRuntime";
import { DriverPushNotifications } from "../lib/push";

// Error and crash reporting (Sentry), when a DSN was built in: before
// anything renders, so a crash on the first screen is reported too.
initMonitoring("driver");

// The splash stays up until Figtree has loaded and the first screen is laid
// out under it: the root view's onLayout below hides it.
holdSplashScreen();

const queryClient = new QueryClient();

// Coming back from the background refetches active queries — including the
// driver's current trip, so the active-trip banner is never stale.
installAppStateFocusManager();

/** Drops the previous driver's cached trip data on log out / account change. */
function SessionCacheReset() {
  useClearQueryCacheOnAccountChange();
  return null;
}

/**
 * Drops inbound deep links that aren't on the driver allowlist. The app
 * registers the campusride-driver:// scheme, so any other app or web page can
 * launch it with a URL of its choosing; anything unrecognised sends us back
 * to the start screen instead of opening an arbitrary route. The one
 * parameterised route (ride/:id) accepts an id-shaped segment only.
 */
function DeepLinkGuard() {
  const router = useRouter();
  const onBlocked = useCallback(() => router.replace("/"), [router]);
  useDeepLinkGuard(DRIVER_DEEP_LINK_POLICY, onBlocked);
  return null;
}

function RootLayout() {
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;

  return (
    // Required for react-native-gesture-handler gestures (the trip screen's
    // slide-to-confirm) to work at all.
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={hideSplashScreen}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DriverLocationProvider>
            <LocationDisclosureProvider>
              <DriverPresenceProvider>
                <DeepLinkGuard />
                <SessionCacheReset />
                <DriverPushNotifications />
                {/* Live location + automatic arrival on every screen during a trip. */}
                <TripRuntime />
                <Stack screenOptions={{ headerShown: false }} />
                {/* An account from before sign-up asked 18+ and the terms: asked once, over every screen. */}
                <TermsConfirmationGate />
              </DriverPresenceProvider>
            </LocationDisclosureProvider>
          </DriverLocationProvider>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

export default withMonitoring(RootLayout);
