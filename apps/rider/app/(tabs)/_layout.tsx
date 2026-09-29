import { useEffect } from "react";
import { View } from "react-native";
import { Redirect, Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LoadingState, RoleMismatchScreen, Screen, colors, shadows, useAuth } from "@rida/mobile-shared";
import { ActiveRideBanner } from "../../components/ActiveRideBanner";
import { activeRideParams, claimLaunchRideCheck, useActiveRide } from "../../lib/activeRide";

/** Bottom tab shell — Home / Rides / Account. Re-checks auth (and role) so a signed-out or mismatched-role user can't land here directly. */
export default function TabsLayout() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const router = useRouter();
  const { data: activeRide, isFetched: activeRideChecked } = useActiveRide();

  // App launched (or reopened after being killed) mid-ride: go straight to it.
  useEffect(() => {
    if (!activeRideChecked || !claimLaunchRideCheck()) return;
    if (activeRide) router.push({ pathname: "/ride/type", params: activeRideParams(activeRide) });
  }, [activeRideChecked, activeRide, router]);

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

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Above the tabs, so it shows on Home, Rides and Account alike. */}
      {activeRide ? <ActiveRideBanner ride={activeRide} /> : null}
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary[500],
        tabBarInactiveTintColor: colors.ink[300],
        // No fixed height/paddingBottom: the tab bar then adds the phone's
        // bottom safe-area inset itself. A hard-coded height of 64 used to
        // override it, pushing labels into the home-indicator / gesture area.
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          paddingTop: 6,
          ...shadows.sm,
        },
        tabBarLabelStyle: {
          fontSize: 13,
          fontWeight: "600",
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
