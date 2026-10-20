import { StyleSheet, View } from "react-native";
import { activeRideStatusLine, stopLabel } from "@rida/shared";
import {
  BottomSheet,
  Button,
  Illustration,
  Text,
  spacing,
  type ActiveRideSummary,
} from "@rida/mobile-shared";

/**
 * Shown on Choose a ride instead of a raw "active ride" error: the rider
 * already has a ride going on (seen on open, or the server refused the
 * request with 409). "Go to my ride" is the primary way out; "Cancel it"
 * opens that ride's cancel sheet. `ride` may be null for a moment while the
 * summary loads after a 409 — the buttons still work, from the id.
 */
export function RideInProgressSheet({
  visible,
  ride,
  busy,
  onGoToRide,
  onCancelIt,
  onDismiss,
}: {
  visible: boolean;
  ride: ActiveRideSummary | null;
  busy: boolean;
  onGoToRide: () => void;
  onCancelIt: () => void;
  onDismiss: () => void;
}) {
  const status = ride
    ? activeRideStatusLine({
        status: ride.status,
        type: ride.type,
        legStatus: ride.legStatus,
        driverFirstName: ride.driver?.firstName,
      })
    : null;

  return (
    <BottomSheet
      modal
      visible={visible}
      onDismiss={onDismiss}
      accessibilityLabel="You already have a ride in progress"
      contentStyle={styles.content}
    >
      <Illustration name="carStandard" width={112} style={styles.art} />
      <Text variant="h2" accessibilityRole="header" style={styles.centered}>
        You already have a ride in progress
      </Text>
      {ride ? (
        <Text variant="bodySmall" color="muted" style={styles.centered}>
          {status} · to {stopLabel(ride.dropoffLabel, ride.dropoffZone.name)}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label="Go to my ride" size="lg" onPress={onGoToRide} loading={busy} />
        <Button label="Cancel it" variant="dangerSecondary" onPress={onCancelIt} disabled={busy} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  art: { alignSelf: "center" },
  centered: { textAlign: "center" },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
