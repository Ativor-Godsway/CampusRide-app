import { useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { DRIVER_DEEP_LINK_POLICY } from "@rida/shared";
import { AuthProvider, useDeepLinkGuard } from "@rida/mobile-shared";

const queryClient = new QueryClient();

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
        <DeepLinkGuard />
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
