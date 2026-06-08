import { Redirect, useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import {
  Badge,
  Button,
  Card,
  LoadingState,
  Screen,
  Text,
  colors,
  radii,
  spacing,
  useAuth,
} from "@rida/mobile-shared";

interface ServiceTile {
  key: string;
  title: string;
  description: string;
  status: "live" | "soon";
  onPress: () => void;
}

export default function HomeScreen() {
  const router = useRouter();
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

  const showComingSoon = (service: string) =>
    Alert.alert(`${service} is coming soon`, "We're working on it — check back in a future update.");

  const tiles: ServiceTile[] = [
    {
      key: "ride",
      title: "Ride",
      description: "Request a shared or solo ride across campus",
      status: "live",
      onPress: () => router.push("/ride/location"),
    },
    {
      key: "food",
      title: "Food",
      description: "Order from campus vendors",
      status: "soon",
      onPress: () => showComingSoon("Food delivery"),
    },
    {
      key: "courier",
      title: "Courier",
      description: "Send packages around campus",
      status: "soon",
      onPress: () => showComingSoon("Courier"),
    },
  ];

  return (
    <Screen scroll>
      <View style={styles.header}>
        <View>
          <Text variant="bodySmall" color="muted">
            Welcome back
          </Text>
          <Text variant="h1">{user.name}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={() => void signOut()} style={styles.profileButton}>
          <Text variant="label" color="primary">
            Log out
          </Text>
        </Pressable>
      </View>

      <Text variant="label" color="muted" style={styles.sectionLabel}>
        SERVICES
      </Text>

      <View style={styles.tiles}>
        {tiles.map((tile) => (
          <Pressable key={tile.key} onPress={tile.onPress} accessibilityRole="button">
            <Card style={[styles.tile, tile.status === "soon" && styles.tileSoon]}>
              <View style={styles.tileHeader}>
                <Text variant="h3" color={tile.status === "soon" ? "muted" : "default"}>
                  {tile.title}
                </Text>
                {tile.status === "soon" ? (
                  <Badge label="Soon" variant="soon" />
                ) : (
                  <Badge label="Live" variant="success" />
                )}
              </View>
              <Text variant="bodySmall" color="muted" style={styles.tileDescription}>
                {tile.description}
              </Text>
            </Card>
          </Pressable>
        ))}
      </View>

      <View style={styles.footer}>
        <Button label="Request a ride" onPress={() => router.push("/ride/location")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing["2xl"],
  },
  profileButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  sectionLabel: {
    marginBottom: spacing.md,
    letterSpacing: 1,
  },
  tiles: {
    gap: spacing.md,
  },
  tile: {
    gap: spacing.xs,
  },
  tileSoon: {
    backgroundColor: colors.surface,
  },
  tileHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tileDescription: {
    marginTop: spacing.xs,
  },
  footer: {
    marginTop: spacing["2xl"],
  },
});
