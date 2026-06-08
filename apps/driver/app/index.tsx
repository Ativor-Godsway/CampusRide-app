import { Redirect } from "expo-router";
import { LoadingState, Screen, Text, Button, spacing, useAuth } from "@rida/mobile-shared";
import { StyleSheet, View } from "react-native";

export default function DriverHomeScreen() {
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

  return (
    <Screen>
      <View style={styles.content}>
        <Text variant="bodySmall" color="muted">
          Welcome back
        </Text>
        <Text variant="h1">{user.name}</Text>
        <Text variant="body" color="muted" style={styles.body}>
          The driver app is coming in Phase 6 — trip requests, navigation, and earnings will
          live here.
        </Text>
        <Button label="Log out" variant="secondary" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.lg,
  },
  body: {
    marginBottom: spacing.md,
  },
});
