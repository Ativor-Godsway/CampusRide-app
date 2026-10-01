import { StyleSheet, View } from "react-native";
import type { SeatState } from "@rida/shared";
import { colors, radii, withAlpha } from "@rida/mobile-shared";

/** Seat dots: filled = on board, light = being picked up, outline = free. */
export function SeatDots({ seats }: { seats: readonly SeatState[] }) {
  const onboard = seats.filter((s) => s === "onboard").length;
  const coming = seats.filter((s) => s === "coming").length;
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`${onboard} on board, ${coming} to pick up, ${seats.length - onboard - coming} free seats`}
    >
      {seats.map((s, i) => (
        <View key={i} style={[styles.dot, s === "onboard" ? styles.onboard : s === "coming" ? styles.coming : styles.empty]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 10, height: 10, borderRadius: radii.full },
  onboard: { backgroundColor: colors.primary[500] },
  coming: { backgroundColor: withAlpha(colors.primary[500], 0.35) },
  empty: { borderWidth: 1.5, borderColor: colors.ink[200] },
});
