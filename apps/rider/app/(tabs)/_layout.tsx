import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Redirect, Tabs, usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  RoleMismatchScreen,
  colors,
  fonts,
  useAuth,
  usePushPermissionPrompt,
  SessionRestoringScreen,
} from "@rida/mobile-shared";
import { ActiveRideBanner } from "../../components/ActiveRideBanner";
import { activeRideParams, claimLaunchRideCheck, useActiveRide } from "../../lib/activeRide";

/** Bottom tab shell — Home / Rides / Account. Re-checks auth (and role) so a signed-out or mismatched-role user can't land here directly. */
export default function TabsLayout() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { data: activeRide, isFetched: activeRideChecked } = useActiveRide();

  // App launched (or reopened after being killed) mid-ride: go straight to it.
  useEffect(() => {
    if (!activeRideChecked || !claimLaunchRideCheck()) return;
    if (activeRide) router.push({ pathname: "/ride/type", params: activeRideParams(activeRide) });
  }, [activeRideChecked, activeRide, router]);

  // Once, after login, and never mid-ride: explain notifications, then ask.
  usePushPermissionPrompt(
    !isLoading && isAuthenticated && user?.role === "RIDER" && activeRideChecked && !activeRide,
    () => router.push("/notifications"),
  );

  if (isLoading) return <SessionRestoringScreen />;

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/welcome" />;
  }

  if (user.role !== "RIDER") {
    return <RoleMismatchScreen expectedRole="RIDER" onSignOut={signOut} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Above Rides and Account. Home shows the ride as the first row of its sheet. */}
      {activeRide && pathname !== "/" ? <ActiveRideBanner ride={activeRide} /> : null}
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green500,
        tabBarInactiveTintColor: colors.ink3,
        // No fixed height/paddingBottom: the tab bar then adds the phone's
        // bottom safe-area inset itself. A hard-coded height of 64 used to
        // override it, pushing labels into the home-indicator / gesture area.
        // White, a hairline on top, no shadow (docs/design-system.md).
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.line,
          borderTopWidth: StyleSheet.hairlineWidth,
          paddingTop: 6,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabelStyle: {
          fontFamily: fonts.semibold,
          fontSize: 12,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "home" : "home-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="rides"
        options={{
          title: "Rides",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "time" : "time-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="account"
        options={{
          title: "Account",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "person" : "person-outline"} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
    </View>
  );
}
