import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Text, colors, radii, spacing, useReduceMotion } from "@rida/mobile-shared";
import { useScheduledOffers } from "../../lib/schedule";
import { ScheduledCarCard } from "./ScheduledCarCard";

/**
 * A scheduled car offered to this driver (socket driver:scheduled_offer):
 * a calm sheet with the car, Accept and "Not now". Not shown while the
 * driver is on a trip (`hidden`); the car stays in the Schedule tab and on
 * the board either way. No countdown: it's open until the car fills or its
 * time comes.
 */
export function ScheduledOfferPopup({ hidden }: { hidden: boolean }) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const { offer, dismiss } = useScheduledOffers();
  const visible = offer !== null && !hidden;
  return (
    <Modal visible={visible} transparent animationType={reduceMotion ? "fade" : "slide"} onRequestClose={() => offer && dismiss(offer.carId)}>
      <Pressable style={styles.scrim} onPress={() => offer && dismiss(offer.carId)} accessibilityRole="button" accessibilityLabel="Not now" />
      {offer ? (
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing[4]) }]} accessibilityViewIsModal>
          <Text variant="eyebrow" color="secondary">
            New scheduled trip
          </Text>
          <Text variant="title3">{offer.label}</Text>
          <ScheduledCarCard car={offer} source="POPUP" onDone={() => dismiss(offer.carId)} />
          <Button label="Not now" variant="neutral" onPress={() => dismiss(offer.carId)} />
        </View>
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: colors.scrim },
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, padding: spacing.gutter, gap: spacing[3] },
});
