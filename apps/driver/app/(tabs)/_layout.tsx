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
import { driverSetupRoute } from "../../lib/driverGate";
import { ActiveTripBanner } from "../../components/ActiveTripBanner";
import { useDriverActiveTrip } from "../../lib/activeTrip";
import { ScheduledOfferPopup } from "../../components/schedule/ScheduledOfferPopup";
import { useDriverSchedule } from "../../lib/schedule";

/** Bottom tab shell — Home / Requests / Earnings / Account. Re-checks auth, role, onboarding and approval so a signed-out, mismatched-role, not-yet-onboarded or not-yet-approved user can't land here directly. */
export default function TabsLayout() {
  const { isLoading, isAuthenticated, user, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { data: activeTrip, isFetched: tripChecked } = useDriverActiveTrip();
  // The trip banner is on Earnings and Account — the way back to the trip.
  // Home shows the trip as the dark first row of its sheet instead.
  const showTripBanner = Boolean(activeTrip) && pathname !== "/";
  // Scheduled rides: keeps the Schedule tab fresh and opens a scheduled trip when it starts.
  useDriverSchedule();

  // Once, after login and approval, and never mid-trip: explain
  // notifications (ride requests reach a closed app through them), then ask.
  usePushPermissionPrompt(
    !isLoading && isAuthenticated && user?.role === "DRIVER" && !driverSetupRoute(user) && tripChecked && !activeTrip,
    () => router.push("/notifications"),
  );

  if (isLoading) return <SessionRestoringScreen />;

  if (!isAuthenticated || !user) {
    return <Redirect href="/auth/welcome" />;
  }

  if (user.role !== "DRIVER") {
    return <RoleMismatchScreen expectedRole="DRIVER" onSignOut={signOut} />;
  }

  const setupRoute = driverSetupRoute(user);
  if (setupRoute) {
    return <Redirect href={setupRoute} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      {/* Above the tabs, so a trip is one tap away from every tab. */}
      {showTripBanner && activeTrip ? <ActiveTripBanner ride={activeTrip} /> : null}
      {/* A scheduled car offered to drivers; never over a trip. */}
      <ScheduledOfferPopup hidden={Boolean(activeTrip)} />
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.green500,
        tabBarInactiveTintColor: colors.ink3,
        // As the rider app: white, a hairline on top, no shadow
        // (docs/design-system.md), and no fixed height, so the tab bar adds
        // the phone's bottom safe-area inset itself.
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
      {/* The request board (2026-11-25): every request on campus still waiting. */}
      <Tabs.Screen
        name="requests"
        options={{
          title: "Requests",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "list" : "list-outline"} size={size} color={color} />
          ),
        }}
      />
      {/* The route stays "rides"; it shows the driver's earnings and completed trips. */}
      <Tabs.Screen
        name="schedule"
        options={{
          title: "Schedule",
          tabBarIcon: ({ focused, color, size }) => (
            <Ionicons name={focused ? "calendar" : "calendar-outline"} size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="rides"
        options={{
          title: "Earnings",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons name={focused ? "cash" : "cash-outline"} size={size} color={color} />
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
