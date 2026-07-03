import { useState } from "react";
import { Redirect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { RoleMismatchScreen, useAuth } from "@rida/mobile-shared";
import { AnimatedSplash } from "../components/AnimatedSplash";

// Hold the native splash until the animated JS splash takes over (no-op in Expo Go).
void SplashScreen.preventAutoHideAsync().catch(() => {});

/** Play the full splash only on cold start — post-login replace("/") lands here again and must gate instantly. */
let hasSplashedThisLaunch = false;

/** Entry — animated splash over the auth gate, then routes to the tab shell, welcome, or role mismatch. */
export default function Index() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const [splashDone, setSplashDone] = useState(hasSplashedThisLaunch);

  if (!splashDone) {
    return (
      <AnimatedSplash
        ready={!isLoading}
        onFinished={() => {
          hasSplashedThisLaunch = true;
          setSplashDone(true);
        }}
      />
    );
  }

  if (isLoading) return null;

  if (!isAuthenticated || !user) {
    return <Redirect href="/welcome" />;
  }

  if (user.role !== "RIDER") {
    return <RoleMismatchScreen expectedRole="RIDER" onSignOut={signOut} />;
  }

  return <Redirect href="/(tabs)" />;
}
