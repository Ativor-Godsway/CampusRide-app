import { StyleSheet, View } from "react-native";
import { requestedAgo } from "@rida/shared";
import {
  BottomSheet,
  ListRow,
  StatusChip,
  Text,
  spacing,
  type FillSuggestion,
} from "@rida/mobile-shared";

/**
 * "Add a rider": the waiting Shared requests the driver can add to the car —
 * before departure, or while driving if the detour keeps riders already in
 * the car within 5 minutes (the preview says so). One row each, best matches
 * first; tapping one opens it full screen (AddRiderTakeover) with the route
 * and the detour, where the driver adds or declines.
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
    <BottomSheet
      modal
      scrollable
      visible={visible}
      onDismiss={onClose}
      maxHeightRatio={0.8}
      accessibilityLabel="Add a rider"
    >
      <View style={styles.heading}>
        <Text variant="title2" accessibilityRole="header">
          Add a rider
        </Text>
        <Text variant="subhead" color="secondary">
          {freeSeats === 0
            ? "Your car is full."
            : `${freeSeats} free seat${freeSeats === 1 ? "" : "s"} · Shared riders waiting near you`}
        </Text>
      </View>
      {freeSeats > 0 && suggestions.length === 0 ? (
        <Text variant="body" color="secondary" style={styles.empty}>
          Nobody else is waiting right now. New requests appear here as they come in.
        </Text>
      ) : null}
      {freeSeats > 0 ? (
        <View>
          {suggestions.map((s, i) => {
            const from = s.pickupPlaceName ?? s.pickupZoneName;
            const to = s.dropoffPlaceName ?? s.dropoffZoneName;
            return (
              <ListRow
                key={s.requestRideId}
                divider={i > 0}
                title={`${from} → ${to}`}
                subtitle={`${s.riderFirstName ? `${s.riderFirstName} · ` : ""}${requestedAgo(s.createdAt)}`}
                leading={<ListRow.Icon name="person-add-outline" />}
                trailing={
                  s.compatible ? (
                    <StatusChip tone="brand" label="On your way" style={styles.chip} />
                  ) : undefined
                }
                onPress={() => onAdd(s)}
                accessibilityLabel={`See the route with the rider from ${from} to ${to}`}
              />
            );
          })}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  heading: { gap: spacing[1], marginBottom: spacing[2] },
  empty: { paddingVertical: spacing[4] },
  chip: { alignSelf: "center" },
});
