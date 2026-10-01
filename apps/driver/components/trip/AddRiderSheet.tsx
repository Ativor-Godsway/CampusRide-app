import { ScrollView, StyleSheet, View } from "react-native";
import { requestedAgo } from "@rida/shared";
import { Badge, Button, Sheet, Text, colors, spacing, typography, type FillSuggestion } from "@rida/mobile-shared";

/**
 * "Add a rider": the waiting Shared requests the driver can add to the car
 * before the first pickup. Compact rows (route + age + Add) in a sheet —
 * replaces the long list that used to sit under the car. Best matches first.
 */
export function AddRiderSheet({
  visible,
  onClose,
  suggestions,
  freeSeats,
  onAdd,
}: {
  visible: boolean;
  onClose: () => void;
  suggestions: readonly FillSuggestion[];
  freeSeats: number;
  onAdd: (suggestion: FillSuggestion) => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="h3" accessibilityRole="header">
        Add a rider
      </Text>
      <Text variant="caption" color="muted">
        {freeSeats === 0
          ? "Your car is full."
          : `${freeSeats} free seat${freeSeats === 1 ? "" : "s"} · Shared riders waiting near you`}
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {freeSeats > 0 && suggestions.length === 0 ? (
          <Text variant="bodySmall" color="muted" style={styles.empty}>
            Nobody else is waiting right now. New requests appear here as they come in.
          </Text>
        ) : null}
        {freeSeats > 0
          ? suggestions.map((s) => (
              <View key={s.requestRideId} style={styles.row}>
                <View style={styles.text}>
                  <Text variant="bodyMedium" style={styles.route} numberOfLines={1}>
                    {s.pickupZoneName} → {s.dropoffZoneName}
                  </Text>
                  <View style={styles.meta}>
                    {s.compatible ? <Badge variant="accent" label="On your way" /> : null}
                    <Text variant="caption" color="muted">
                      {requestedAgo(s.createdAt)}
                    </Text>
                  </View>
                </View>
                <Button
                  label="Add"
                  fullWidth={false}
                  onPress={() => onAdd(s)}
                  accessibilityLabel={`Add rider from ${s.pickupZoneName} to ${s.dropoffZoneName}`}
                />
              </View>
            ))
          : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 400, marginTop: spacing.md },
  listContent: { gap: spacing.sm },
  empty: { paddingVertical: spacing.lg, textAlign: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  text: { flex: 1, gap: spacing.xs },
  route: { fontWeight: typography.weight.semibold },
  meta: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
