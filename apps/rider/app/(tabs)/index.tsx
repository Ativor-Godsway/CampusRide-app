import { useRouter } from "expo-router";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Button,
  Card,
  ListRow,
  Screen,
  Text,
  colors,
  spacing,
  useAuth,
} from "@rida/mobile-shared";

/**
 * Home tab placeholder for R1 — keeps the verified "request a ride" flow
 * reachable while R2 builds the real Uber-style "Where to?" home screen.
 */
export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();

  const showComingSoon = (service: string) =>
    Alert.alert(`${service} is coming soon`, "We're working on it — check back in a future update.");

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="bodySmall" color="muted">
          Welcome back
        </Text>
        <Text variant="h1">{user?.name ?? "Rider"}</Text>
      </View>

      <Card style={styles.heroCard}>
        <View style={styles.heroIcon}>
          <Ionicons name="navigate" size={24} color={colors.primary[600]} />
        </View>
        <Text variant="h2" style={styles.heroTitle}>
          Where are you headed?
        </Text>
        <Text variant="body" color="muted" style={styles.heroSubtitle}>
          Request a shared or solo ride across campus in seconds.
        </Text>
        <Button label="Request a ride" onPress={() => router.push("/ride/location")} />
      </Card>

      <Text variant="label" color="muted" style={styles.sectionLabel}>
        MORE SERVICES
      </Text>

      <Card>
        <ListRow
          title="Food"
          subtitle="Order from campus vendors"
          leading={<ListRow.Icon name="fast-food-outline" color={colors.accent[600]} background={colors.accent[50]} />}
          onPress={() => showComingSoon("Food delivery")}
          showChevron={false}
          trailing={<Text variant="caption" color="muted">Soon</Text>}
        />
        <View style={styles.divider} />
        <ListRow
          title="Courier"
          subtitle="Send packages around campus"
          leading={<ListRow.Icon name="cube-outline" color={colors.accent[600]} background={colors.accent[50]} />}
          onPress={() => showComingSoon("Courier")}
          showChevron={false}
          trailing={<Text variant="caption" color="muted">Soon</Text>}
        />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.xl,
  },
  heroCard: {
    marginBottom: spacing["2xl"],
    gap: spacing.sm,
  },
  heroIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.primary[50],
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.xs,
  },
  heroTitle: {
    marginTop: spacing.xs,
  },
  heroSubtitle: {
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    marginBottom: spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
});
