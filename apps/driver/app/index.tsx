import { Redirect } from "expo-router";
import { LoadingState, RoleMismatchScreen, Screen, useAuth } from "@rida/mobile-shared";

/** Pure auth gate — routes to the tab shell when signed in and onboarded, or the auth/onboarding flow otherwise. */
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

  if (!user.driver || !user.driver.carMake) {
    return <Redirect href="/onboarding" />;
  }

  return <Redirect href="/(tabs)" />;
}
