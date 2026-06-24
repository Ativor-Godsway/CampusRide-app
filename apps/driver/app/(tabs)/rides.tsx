import { View } from "react-native";
import { StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Card, EmptyState, Screen, Text, colors, formatGhs, spacing } from "@rida/mobile-shared";

/**
 * Rides tab — earnings-first layout. There is no driver-side completed-rides
 * endpoint yet (only /driver/rides/active and /driver/rides/eligible exist),
 * so this renders an honest empty state rather than fabricated history.
 */
export default function RidesTab() {
  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="h1">Your rides</Text>
      </View>

      <Card style={styles.earningsCard}>
        <Text variant="label" color="muted">TODAY&apos;S EARNINGS</Text>
        <Text variant="h1" style={styles.earningsAmount}>{formatGhs(0)}</Text>
      </Card>

      <EmptyState
        title="No completed rides yet"
        message="Your trip history and earnings will show up here once you complete your first ride."
        icon={<Ionicons name="time-outline" size={48} color={colors.ink[300]} />}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    marginBottom: spacing.xl,
  },
  earningsCard: {
    gap: spacing.xs,
    marginBottom: spacing.xl,
  },
  earningsAmount: {
    color: colors.primary[600],
  },
});
