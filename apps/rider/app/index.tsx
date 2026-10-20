import { Redirect } from "expo-router";
import { RoleMismatchScreen, SessionRestoringScreen, useAuth } from "@rida/mobile-shared";

/** Pure auth gate — routes to the tab shell when signed in, or the auth flow otherwise. */
export default function Index() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();

  if (isLoading) return <SessionRestoringScreen />;

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/welcome" />;
  }

  if (user.role !== "RIDER") {
    return <RoleMismatchScreen expectedRole="RIDER" onSignOut={signOut} />;
  }

  return <Redirect href="/(tabs)" />;
}
