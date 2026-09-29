import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { activeRideStatusLine } from "@rida/shared";
import {
  Button,
  Illustration,
  Text,
  colors,
  radii,
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
  const sheetRef = useRef<BottomSheet>(null);
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (visible) sheetRef.current?.expand();
    else sheetRef.current?.close();
  }, [visible]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

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
      ref={sheetRef}
      index={-1}
      enablePanDownToClose
      enableDynamicSizing
      onClose={onDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetView
        style={[
          styles.content,
          { paddingBottom: Math.max(insets.bottom, spacing.lg) + spacing.sm },
        ]}
        accessibilityViewIsModal
      >
        <Illustration name="carStandard" width={112} style={styles.art} />
        <Text variant="h2" accessibilityRole="header" style={styles.centered}>
          You already have a ride in progress
        </Text>
        {ride ? (
          <Text variant="bodySmall" color="muted" style={styles.centered}>
            {status} · to {ride.dropoffZone.name}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button label="Go to my ride" size="lg" onPress={onGoToRide} loading={busy} />
          <Button
            label="Cancel it"
            variant="dangerSecondary"
            onPress={onCancelIt}
            disabled={busy}
          />
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
  },
  handle: { backgroundColor: colors.borderStrong, width: 40, height: 5 },
  content: { paddingHorizontal: spacing.xl, paddingTop: spacing.xs, gap: spacing.md },
  art: { alignSelf: "center" },
  centered: { textAlign: "center" },
  actions: { gap: spacing.md, marginTop: spacing.sm },
});
