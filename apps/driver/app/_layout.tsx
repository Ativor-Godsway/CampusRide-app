import { useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { DRIVER_DEEP_LINK_POLICY } from "@rida/shared";
import {
  AuthProvider,
  installAppStateFocusManager,
  useClearQueryCacheOnAccountChange,
  useDeepLinkGuard,
} from "@rida/mobile-shared";
import { DriverPresenceProvider } from "../lib/presence";
import { DriverLocationProvider } from "../lib/location";

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

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DriverLocationProvider>
          <DriverPresenceProvider>
            <DeepLinkGuard />
            <SessionCacheReset />
            <Stack screenOptions={{ headerShown: false }} />
          </DriverPresenceProvider>
        </DriverLocationProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
