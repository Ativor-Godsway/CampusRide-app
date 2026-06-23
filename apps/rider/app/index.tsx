import { Redirect } from "expo-router";
import { LoadingState, RoleMismatchScreen, Screen, useAuth } from "@rida/mobile-shared";

/** Pure auth gate — routes to the tab shell when signed in, or the auth flow otherwise. */
export default function Index() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();

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

  if (user.role !== "RIDER") {
    return <RoleMismatchScreen expectedRole="RIDER" onSignOut={signOut} />;
  }

  return <Redirect href="/(tabs)" />;
}
