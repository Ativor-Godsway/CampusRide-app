import { Redirect } from "expo-router";
import { LoadingState, Screen, useAuth } from "@rida/mobile-shared";

/** Pure auth gate — routes to the tab shell when signed in, or the auth flow otherwise. */
export default function Index() {
  const { isLoading, isAuthenticated, user } = useAuth();

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  return <Redirect href="/(tabs)" />;
}
