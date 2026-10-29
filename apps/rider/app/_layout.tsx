import { useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter, type ErrorBoundaryProps } from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { RIDER_DEEP_LINK_POLICY, holdUpdateScreen } from "@rida/shared";
import {
  AppErrorScreen,
  AppUpdateGate,
  AuthProvider,
  TermsConfirmationGate,
  hideSplashScreen,
  holdSplashScreen,
  initMonitoring,
  installAppStateFocusManager,
  useAppFonts,
  useDeepLinkGuard,
  withMonitoring,
} from "@rida/mobile-shared";
import { useResetCacheOnAccountChange, useRiderTripState } from "../lib/activeRide";
import { RiderPushNotifications } from "../lib/push";

// Error and crash reporting (Sentry), when a DSN was built in: before
// anything renders, so a crash on the first screen is reported too.
initMonitoring("rider");

// The splash stays up until Figtree has loaded and the first screen is laid
// out under it: the root view's onLayout below hides it.
holdSplashScreen();

const queryClient = new QueryClient();

// Coming back from the background refetches active queries — the
// active-ride banner and a ride's status included.
installAppStateFocusManager();

/**
 * Drops inbound deep links that aren't on the rider allowlist. The app
 * registers the campusride-rider:// scheme, so any other app or web page can
 * launch it with a URL of its choosing; anything unrecognised sends us back
 * to the start screen instead of opening an arbitrary route.
 */
function DeepLinkGuard() {
  const router = useRouter();
  const onBlocked = useCallback(() => router.replace("/"), [router]);
  useDeepLinkGuard(RIDER_DEEP_LINK_POLICY, onBlocked);
  return null;
}

/** Must sit inside both QueryClientProvider and AuthProvider. */
function SessionCacheReset() {
  useResetCacheOnAccountChange();
  return null;
}

/**
 * "Time to update" when this store version is below the server's minimum
 * (docs/runbooks/releasing.md): never during a ride; it shows once the ride
 * is over.
 */
function RiderUpdateGate() {
  const trip = useRiderTripState();
  return <AppUpdateGate app="rider" hold={holdUpdateScreen({ trip, onTripScreen: false })} />;
}

function RootLayout() {
  const fontsReady = useAppFonts();
  if (!fontsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={hideSplashScreen}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DeepLinkGuard />
          <SessionCacheReset />
          <RiderPushNotifications />
          <Stack screenOptions={{ headerShown: false }} />
          {/* An account from before sign-up asked 18+ and the terms: asked once, over every screen. */}
          <TermsConfirmationGate />
          {/* Last, so it covers everything else, the terms confirmation included. */}
          <RiderUpdateGate />
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

/** A screen that throws shows "Something went wrong" with a retry instead of going blank. */
export function ErrorBoundary(props: ErrorBoundaryProps) {
  return <AppErrorScreen {...props} where="rider-root" />;
}

export default withMonitoring(RootLayout);
