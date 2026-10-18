import { View } from "react-native";
import { Redirect, Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import {
  RoleMismatchScreen,
  colors,
  shadows,
  useAuth,
  usePushPermissionPrompt,
  SessionRestoringScreen,
} from "@rida/mobile-shared";
import { driverSetupRoute } from "../../lib/driverGate";
import { ActiveTripBanner } from "../../components/ActiveTripBanner";
import { useDriverActiveTrip } from "../../lib/activeTrip";

/** Bottom tab shell — Home / Rides / Account. Re-checks auth, role, onboarding and approval so a signed-out, mismatched-role, not-yet-onboarded or not-yet-approved user can't land here directly. */
export default function TabsLayout() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const router = useRouter();
  const { data: activeTrip, isFetched: tripChecked } = useDriverActiveTrip();
  // The trip banner is on every tab, Home included — the one way back to the
  // trip, identical wherever the driver is.
  const showTripBanner = Boolean(activeTrip);

  // Once, after login and approval, and never mid-trip: explain
  // notifications (ride requests reach a closed app through them), then ask.
  usePushPermissionPrompt(
    !isLoading && isAuthenticated && user?.role === "DRIVER" && !driverSetupRoute(user) && tripChecked && !activeTrip,
    () => router.push("/notifications"),
  );

  if (isLoading) return <SessionRestoringScreen />;

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/phone" />;
  }

  if (user.role !== "DRIVER") {
    return <RoleMismatchScreen expectedRole="DRIVER" onSignOut={signOut} />;
  }

  const setupRoute = driverSetupRoute(user);
  if (setupRoute) {
    return <Redirect href={setupRoute} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Above the tabs, so a trip is one tap away from every tab. */}
      {showTripBanner && activeTrip ? <ActiveTripBanner ride={activeTrip} /> : null}
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary[500],
        tabBarInactiveTintColor: colors.ink[300],
        tabBarStyle: {
          backgroundColor: colors.white,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: 64,
          paddingTop: 8,
          paddingBottom: 10,
          ...shadows.sm,
        },
        tabBarLabelStyle: {
          fontSize: 12,
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
