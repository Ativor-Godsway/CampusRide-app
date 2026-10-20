import { useEffect, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { Redirect, Stack, Tabs, useLocalSearchParams, useRouter } from "expo-router";
import { renderRouter, screen } from "expo-router/testing-library";
import * as SecureStore from "expo-secure-store";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { forgetRefreshTokenInMemory } from "../auth/storage";
import { setAccessToken } from "../auth/tokenStore";
import { SessionRestoringScreen } from "../auth/screens/SessionRestoringScreen";
import { goHome } from "../navigation/goHome";
// The apps' real start screens and sign-in layouts and screens.
import RiderStart from "../../../../apps/rider/app/index";
import DriverStart from "../../../../apps/driver/app/index";
import RiderAuthLayout from "../../../../apps/rider/app/auth/_layout";
import DriverAuthLayout from "../../../../apps/driver/app/auth/_layout";
import RiderPhone from "../../../../apps/rider/app/auth/phone";
import DriverPhone from "../../../../apps/driver/app/auth/phone";
import Otp from "../../../../apps/rider/app/auth/otp";
import Signup from "../../../../apps/rider/app/auth/signup";

/**
 * Route trees for the navigation tests, shaped like the two apps: the real
 * start screen (app/index.tsx), sign-in layout and screens, and stand-ins
 * with the same navigation as the tab shell, the trip screens and Account.
 * (The real tab layouts and trip screens pull in maps, sockets and
 * location; what matters here is where their buttons navigate to.)
 */

function TabsGate({ role }: { role: "RIDER" | "DRIVER" }) {
  // As apps/*/app/(tabs)/_layout.tsx.
  const { isLoading, isAuthenticated, user } = useAuth();
  if (isLoading) return <SessionRestoringScreen />;
  if (!isAuthenticated || !user) return <Redirect href="/auth/phone" />;
  if (user.role !== role) return <Text>Wrong app</Text>;
  return <Tabs screenOptions={{ headerShown: false }} />;
}

function Home() {
  const router = useRouter();
  return (
    <View>
      <Text>Home screen</Text>
      <Pressable onPress={() => router.push("/ride/type")}>
        <Text>Open rider trip</Text>
      </Pressable>
      <Pressable onPress={() => router.push("/ride/abc123")}>
        <Text>Open driver trip</Text>
      </Pressable>
    </View>
  );
}

function History() {
  const router = useRouter();
  return (
    <View>
      <Text>History screen</Text>
      <Pressable onPress={() => router.push("/ride/type")}>
        <Text>Open past rider trip</Text>
      </Pressable>
    </View>
  );
}

function Account() {
  const { signOut } = useAuth();
  return (
    <View>
      <Text>Account screen</Text>
      <Pressable onPress={() => void signOut()}>
        <Text>Log out</Text>
      </Pressable>
    </View>
  );
}

/** As apps/rider/app/ride/type.tsx: "Back to home" and the pill's back arrow. */
function RiderTrip() {
  const router = useRouter();
  return (
    <View>
      <Text>Trip complete</Text>
      <Pressable onPress={() => goHome(router)}>
        <Text>Back to home</Text>
      </Pressable>
      <Pressable onPress={() => (router.canGoBack() ? router.back() : goHome(router))}>
        <Text>Back arrow</Text>
      </Pressable>
    </View>
  );
}

/**
 * As apps/driver/app/ride/[id].tsx: the ← button and "Back to Home" both go
 * Home; a trip the rider cancelled goes Home by itself.
 */
function DriverTrip() {
  const router = useRouter();
  const { isLoading, isAuthenticated, user } = useAuth();
  const { cancelled } = useLocalSearchParams<{ cancelled?: string }>();
  useEffect(() => {
    if (!cancelled) return;
    const t = setTimeout(() => goHome(router), 2_500);
    return () => clearTimeout(t);
  }, [cancelled, router]);
  if (isLoading) return <SessionRestoringScreen />;
  if (!isAuthenticated || !user) return <Redirect href="/auth/phone" />;
  return (
    <View>
      <Text>Driver trip</Text>
      <Pressable onPress={() => goHome(router)}>
        <Text>←</Text>
      </Pressable>
    </View>
  );
}

function Root() {
  return (
    <AuthProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}

export function renderApp(app: "rider" | "driver", initialUrl = "/") {
  const routes: Record<string, ComponentType> = {
    _layout: Root,
    index: app === "rider" ? RiderStart : DriverStart,
    "auth/_layout": app === "rider" ? RiderAuthLayout : DriverAuthLayout,
    "auth/phone": app === "rider" ? RiderPhone : DriverPhone,
    "auth/otp": Otp,
    "auth/signup": Signup,
    "(tabs)/_layout": () => <TabsGate role={app === "rider" ? "RIDER" : "DRIVER"} />,
    "(tabs)/index": Home,
    "(tabs)/rides": History,
    "(tabs)/account": Account,
    "ride/type": RiderTrip,
    "ride/[id]": DriverTrip,
  };
  return renderRouter(routes, { initialUrl });
}

// expo-router's own record of where the app is (what renderRouter's
// getPathname/getRouterState read).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { store } = require("expo-router/build/global-state/router-store") as {
  store: {
    getRouteInfo(): { pathname: string };
    state?: { routes: { state?: { routes: { name: string }[] } }[] };
  };
};

/** The current path, as in the address of a web page ("/" is Home). */
export function pathname(): string {
  return store.getRouteInfo().pathname;
}

/** Names of the screens in the root stack's history, bottom first. */
export function history(): string[] {
  return (store.state?.routes[0]?.state?.routes ?? []).map((r) => r.name);
}

/** As a fresh app launch: nothing in memory, whatever is "on disk" stays. */
export async function freshLaunch(): Promise<void> {
  forgetRefreshTokenInMemory();
  setAccessToken(null);
}

/** Puts a refresh token "on disk", as a phone that signed in earlier has. */
export async function storeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync("rida.session.refreshToken", token);
}

export async function onDisk(): Promise<string | null> {
  return SecureStore.getItemAsync("rida.session.refreshToken");
}

/** Signs in through the real phone and code screens. */
export async function signInThroughScreens(fireEvent: typeof import("expo-router/testing-library").fireEvent) {
  await screen.findByText("Log in");
  await fireEvent.changeText(screen.getByLabelText("Phone number"), "0241234567");
  await fireEvent.press(screen.getByText("Log in"));
  // The 6th digit checks the code: there is no Continue button.
  await fireEvent.changeText(await screen.findByLabelText("Verification code, 6 digits"), "123456");
  await screen.findByText("Home screen");
}
