import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { leaveByLabel, scheduleClock, seatsFilledLabel, seatsWord, type DriverScheduledCarView, type ScheduleAcceptedVia } from "@rida/shared";
import { Button, StatusChip, Text, colors, formatCedis, haptics, radii, scheduleErrorText, spacing } from "@rida/mobile-shared";
import { useScheduleActions } from "../../lib/schedule";

/**
 * One scheduled car (rides/scheduled.ts): "Scheduled · 9:30 · 3 seats ·
 * GH₵21", where from and to, the driver's share; for the driver's own cars,
 * Leave by, and each rider's first name, seats, pickup and "coming".
 */
export function ScheduledCarCard({
  car,
  source,
  onDone,
}: {
  car: DriverScheduledCarView;
  /** Where an Accept here comes from (Ride.acceptedVia). */
  source: ScheduleAcceptedVia;
  onDone?: (accepted: boolean) => void;
}) {
  const actions = useScheduleActions();
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    try {
      await actions.accept(car.carId, source);
      haptics.success();
      onDone?.(true);
    } catch (err) {
      Alert.alert("Couldn't accept", scheduleErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  function giveBack() {
    Alert.alert(`Give back your ${scheduleClock(car.arriveBy)} trip?`, "The riders are told we're finding them a new driver.", [
      { text: "Keep it", style: "cancel" },
      {
        text: "Give back",
        style: "destructive",
        onPress: () => {
          setBusy(true);
          void actions
            .giveBack(car.carId)
            .then(() => onDone?.(false))
            .catch((err) => Alert.alert("Couldn't give it back", scheduleErrorText(err)))
            .finally(() => setBusy(false));
        },
      },
    ]);
  }

  return (
    <View style={styles.card} accessibilityLabel={`${car.label}, ${car.pickupArea} to ${car.dropoffArea}`}>
      <View style={styles.head}>
        <StatusChip label="Scheduled" tone="brand" icon="calendar-outline" />
        <Text variant="title3" tabular style={styles.flex}>
          {scheduleClock(car.arriveBy)}
        </Text>
        <Text variant="title3" tabular>
          {formatCedis(car.farePesewas)}
        </Text>
      </View>
      <Text variant="bodyStrong" numberOfLines={2}>
        {`${car.pickupArea} → ${car.dropoffArea}`}
      </Text>
      <Text variant="subhead" color="secondary">
        {`${car.mine ? seatsFilledLabel(car.seats, car.carSeats) : seatsWord(car.seats)} · you get ${formatCedis(car.driverSharePesewas)}`}
      </Text>
      {car.mine && car.leaveBy ? (
        <View style={styles.row}>
          <Ionicons name="time-outline" size={18} color={colors.green700} />
          <Text variant="bodyStrong" color="brand">
            {leaveByLabel(Date.parse(car.leaveBy))}
          </Text>
        </View>
      ) : null}
      {car.riders.map((r, i) => (
        <View key={`${r.firstName}-${i}`} style={styles.row}>
          <Ionicons name={r.coming ? "checkmark-circle" : "person-outline"} size={18} color={r.coming ? colors.green500 : colors.ink2} />
          <Text variant="subhead" style={styles.flex} numberOfLines={1}>
            {`${r.firstName}${r.seats > 1 ? ` +${r.seats - 1}` : ""} · ${r.pickupLabel}`}
          </Text>
          {r.coming ? (
            <Text variant="caption" color="brand">
              Coming
            </Text>
          ) : null}
        </View>
      ))}
      {car.note ? (
        <Text variant="caption" color="warning">
          {car.note}
        </Text>
      ) : null}
      {car.mine ? (
        <Button label="Give back" variant="text" size="md" loading={busy} onPress={giveBack} />
      ) : (
        <Button label={`Accept · ${formatCedis(car.farePesewas)}`} size="md" disabled={!car.canAccept} loading={busy} onPress={() => void accept()} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.lg, backgroundColor: colors.surface2, padding: spacing[4], gap: spacing[2] },
  head: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  flex: { flex: 1 },
});
