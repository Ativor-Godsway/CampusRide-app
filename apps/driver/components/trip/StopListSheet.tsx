import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { firstName, formatCedis, riderName, riderStatusWord, type TripStop } from "@rida/shared";
import {
  Sheet,
  Text,
  callPhone,
  colors,
  radii,
  spacing,
  typography,
  type PassengerInCar,
} from "@rida/mobile-shared";

/**
 * "Your stops" (sketch 8): every remaining stop in route order, each with
 * the rider's name and where they are in one word (Waiting / Arrived /
 * In car), then the riders already dropped off. Green = pickups, black =
 * drop-offs. Tapping a stop calls that rider.
 */
export function StopListSheet({
  visible,
  onClose,
  stops,
  passengers,
  nextEtaMinutes,
}: {
  visible: boolean;
  onClose: () => void;
  stops: readonly TripStop[];
  /** Every rider on the trip (for the "Done" list). */
  passengers: readonly PassengerInCar[];
  nextEtaMinutes: number | null;
}) {
  const done = passengers.filter((p) => p.status === "DROPPED_OFF");
  return (
    <Sheet visible={visible} onClose={onClose}>
      <Text variant="h3" accessibilityRole="header">
        Your stops
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {stops.map((stop, i) => {
          const name = riderName(stop);
          const word = riderStatusWord(stop.passengerStatus);
          const eta = i === 0 && nextEtaMinutes !== null && stop.passengerStatus !== "ARRIVED" ? ` · ${nextEtaMinutes} min` : "";
          return (
            <Pressable
              key={stop.key}
              disabled={!stop.riderPhone}
              onPress={() => stop.riderPhone && void callPhone(stop.riderPhone, name)}
              accessibilityRole="button"
              accessibilityLabel={`Stop ${i + 1}: ${stop.kind === "PICKUP" ? "pick up" : "drop off"} ${name} at ${stop.zone.name}. ${word}.${stop.riderPhone ? " Double-tap to call." : ""}`}
              style={styles.row}
            >
              <View style={[styles.number, stop.kind === "PICKUP" ? styles.pickup : styles.dropoff]}>
                <Text variant="caption" style={styles.numberText}>
                  {i + 1}
                </Text>
              </View>
              <View style={styles.text}>
                <Text variant="bodyMedium" style={styles.title} numberOfLines={1}>
                  {stop.kind === "PICKUP" ? "Pick up" : "Drop off"} {name}
                </Text>
                <Text variant="caption" color="muted" numberOfLines={2}>
                  {stop.zone.name}
                  {stop.kind === "DROPOFF" && stop.farePesewas !== null ? ` · ${formatCedis(stop.farePesewas)}` : ""}
                </Text>
              </View>
              <Text variant="caption" style={styles.word}>
                {word}
                {eta}
              </Text>
              {stop.riderPhone ? <Ionicons name="call-outline" size={18} color={colors.ink[400]} /> : null}
            </Pressable>
          );
        })}

        {done.length > 0 ? (
          <>
            <Text variant="label" color="muted" style={styles.doneHeader}>
              DONE
            </Text>
            {done.map((p) => (
              <View key={p.id} style={styles.row} accessible accessibilityLabel={`${firstName(p.riderName) || "Rider"}: dropped off at ${p.dropoffZoneName}`}>
                <View style={[styles.number, styles.doneDot]}>
                  <Ionicons name="checkmark" size={14} color={colors.white} />
                </View>
                <View style={styles.text}>
                  <Text variant="bodyMedium" style={styles.doneTitle} numberOfLines={1}>
                    {firstName(p.riderName) || "Rider"}
                  </Text>
                  <Text variant="caption" color="muted" numberOfLines={1}>
                    {p.dropoffZoneName}
                  </Text>
                </View>
                <Text variant="caption" color="muted">
                  {riderStatusWord("DROPPED_OFF")}
                </Text>
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
      <Text variant="caption" color="muted" style={styles.footnote}>
        Order follows the route. Tap a rider to call them.
      </Text>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 440, marginTop: spacing.md },
  listContent: { gap: spacing.xs },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, minHeight: 52 },
  number: { width: 28, height: 28, borderRadius: radii.full, alignItems: "center", justifyContent: "center" },
  pickup: { backgroundColor: colors.primary[500] },
  dropoff: { backgroundColor: colors.ink[900] },
  doneDot: { backgroundColor: colors.ink[300] },
  numberText: { color: colors.white, fontWeight: typography.weight.extrabold },
  text: { flex: 1, gap: 1, minWidth: 0 },
  title: { fontWeight: typography.weight.bold },
  doneTitle: { color: colors.ink[500] },
  word: { color: colors.ink[700], fontWeight: typography.weight.semibold },
  doneHeader: { marginTop: spacing.md },
  footnote: { marginTop: spacing.md },
});
