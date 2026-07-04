import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { LoadingState, RoleMismatchScreen, Screen, colors, shadows, useAuth } from "@rida/mobile-shared";

/** Bottom tab shell — Home / Rides / Account. Re-checks auth (and role) so a signed-out or mismatched-role user can't land here directly. */
export default function TabsLayout() {
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

  return (
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
  );
}
