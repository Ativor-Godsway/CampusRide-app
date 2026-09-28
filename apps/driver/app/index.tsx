import { Redirect } from "expo-router";
import { LoadingState, RoleMismatchScreen, Screen, useAuth } from "@rida/mobile-shared";
import { driverSetupRoute } from "../lib/driverGate";

/** Pure auth gate — routes to the tab shell when signed in, onboarded and approved; otherwise to the auth, onboarding or waiting-for-approval screen. */
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

  if (user.role !== "DRIVER") {
    return <RoleMismatchScreen expectedRole="DRIVER" onSignOut={signOut} />;
  }

  // Onboarding (car + photo) → waiting for approval → the app.
  const setupRoute = driverSetupRoute(user);
  if (setupRoute) {
    return <Redirect href={setupRoute} />;
  }

  return <Redirect href="/(tabs)" />;
}
