import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { formatCedis, type TripStop } from "@rida/shared";
import { Sheet, Text, callPhone, colors, radii, spacing, typography } from "@rida/mobile-shared";

/** One word for where this rider is, as in the design: Arrived · On board · Waiting · 3 min. */
function stopWord(stop: TripStop, eta: number | null, isNext: boolean): string {
  if (stop.kind === "PICKUP") {
    if (stop.passengerStatus === "ARRIVED") return "Arrived";
    return isNext && eta !== null ? `${eta} min` : "Waiting";
  }
  return stop.passengerStatus === "PICKED_UP" ? "On board" : "Waiting";
}

/**
 * "Your stops" (sketch 8): every remaining stop in route order. Green =
 * pickups, black = drop-offs. Tapping a stop calls that rider.
 */
export function StopListSheet({
  visible,
  onClose,
  stops,
  nextEtaMinutes,
}: {
  visible: boolean;
  onClose: () => void;
  stops: readonly TripStop[];
  nextEtaMinutes: number | null;
}) {
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="h3" accessibilityRole="header">
        Your stops
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {stops.map((stop, i) => (
          <Pressable
            key={stop.key}
            disabled={!stop.riderPhone}
            onPress={() => stop.riderPhone && void callPhone(stop.riderPhone, stop.riderFirstName)}
            accessibilityRole="button"
            accessibilityLabel={`Stop ${i + 1}: ${stop.kind === "PICKUP" ? "pick up" : "drop off"} ${stop.riderFirstName} at ${stop.zone.name}. ${stopWord(stop, nextEtaMinutes, i === 0)}.${stop.riderPhone ? " Double-tap to call." : ""}`}
            style={styles.row}
          >
            <View style={[styles.number, stop.kind === "PICKUP" ? styles.pickup : styles.dropoff]}>
              <Text variant="caption" style={styles.numberText}>
                {i + 1}
              </Text>
            </View>
            <View style={styles.text}>
              <Text variant="bodyMedium" style={styles.title} numberOfLines={1}>
                {stop.kind === "PICKUP" ? "Pick up" : "Drop off"} {stop.riderFirstName}
              </Text>
              <Text variant="caption" color="muted" numberOfLines={1}>
                {stop.zone.name}
                {stop.kind === "DROPOFF" && stop.farePesewas !== null ? ` · ${formatCedis(stop.farePesewas)}` : ""}
              </Text>
            </View>
            <Text variant="caption" style={styles.word}>
              {stopWord(stop, nextEtaMinutes, i === 0)}
            </Text>
            {stop.riderPhone ? <Ionicons name="call-outline" size={18} color={colors.ink[400]} /> : null}
          </Pressable>
        ))}
      </ScrollView>
      <Text variant="caption" color="muted" style={styles.footnote}>
        Order follows the route. Tap a rider to call them.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 420, marginTop: spacing.md },
  listContent: { gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, minHeight: 52 },
  number: { width: 28, height: 28, borderRadius: radii.full, alignItems: "center", justifyContent: "center" },
  pickup: { backgroundColor: colors.primary[500] },
  dropoff: { backgroundColor: colors.ink[900] },
  numberText: { color: colors.white, fontWeight: typography.weight.extrabold },
  text: { flex: 1, gap: 1 },
  title: { fontWeight: typography.weight.bold },
  word: { color: colors.ink[600], fontWeight: typography.weight.semibold },
  footnote: { marginTop: spacing.md },
});
