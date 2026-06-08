import { useRouter, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button, Card, Screen, Text, colors, spacing } from "@rida/mobile-shared";

/**
 * Lands here right after a ride request is submitted. Live status (driver
 * matched, ETA, location dot) is built in Phase 5c — for now this confirms
 * the request went through and shows what was requested.
 */
export default function SearchingScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    rideId: string;
    type: string;
    pickupZoneName: string;
    dropoffZoneName: string;
    priceLabel: string;
  }>();

  return (
    <Screen>
      <View style={styles.content}>
        <ActivityIndicator size="large" color={colors.primary[500]} />
        <Text variant="h1" style={styles.title}>
          Searching for a driver...
        </Text>
        <Text variant="body" color="muted" style={styles.subtitle}>
          We'll match you with a nearby driver. This usually takes a minute or two.
        </Text>

        <Card style={styles.summary}>
          <View style={styles.summaryRow}>
            <Text variant="label" color="muted">
              ROUTE
            </Text>
            <Text variant="bodyMedium">
              {params.pickupZoneName} → {params.dropoffZoneName}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Text variant="label" color="muted">
              RIDE TYPE
            </Text>
            <Text variant="bodyMedium">{params.type === "SHARED" ? "Shared" : "Lone"}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text variant="label" color="muted">
              ESTIMATED FARE
            </Text>
            <Text variant="bodyMedium">{params.priceLabel}</Text>
          </View>
        </Card>

        <Button label="Back to home" variant="secondary" onPress={() => router.replace("/")} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.md },
  title: { textAlign: "center", marginTop: spacing.lg },
  subtitle: { textAlign: "center", marginBottom: spacing.lg },
  summary: { width: "100%", gap: spacing.md, marginBottom: spacing.xl },
  summaryRow: { gap: spacing.xs },
});
