import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  formatDistance,
  leaveByLabel,
  scheduleClock,
  seatsFilledLabel,
  seatsWord,
  sharedDropoff,
  type DriverScheduledCarView,
  type ScheduleAcceptedVia,
} from "@rida/shared";
import { Button, IconButton, StatusChip, Text, callPhone, colors, formatCedis, haptics, radii, scheduleErrorText, spacing } from "@rida/mobile-shared";
import { useScheduleActions } from "../../lib/schedule";

/** "2 pickups · 1 drop-off · 2.4 km". */
export function routeSummary(route: DriverScheduledCarView["route"]): string | null {
  if (!route) return null;
  const word = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  return `${word(route.pickups, "pickup")} · ${word(route.dropoffs, "drop-off")} · ${formatDistance(route.meters)}`;
}

/**
 * One scheduled car (rides/scheduled.ts). The time big, the total and what
 * the driver gets, Leave by and a route summary; for the driver's own cars
 * each rider in stop order with seats, pickup and drop-off (one shared
 * drop-off line when they all go to the same place) and a Call button (the
 * same call as on a trip). Open cars: where from and to, and Accept.
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
  const allTo = sharedDropoff(car.riders);
  const summary = routeSummary(car.route);

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
    <View style={styles.card}>
      <View style={styles.hero} accessible accessibilityLabel={`${car.label}. ${car.pickupArea} to ${car.dropoffArea}. You get ${formatCedis(car.driverSharePesewas)}.`}>
        <View style={styles.flex}>
          <StatusChip label={car.mine ? "Your scheduled trip" : "Scheduled"} tone="brand" icon="calendar-outline" />
          <Text variant="caption" color="onDark2" style={styles.heroCaption}>
            Arrive by
          </Text>
          <Text variant="display" color="onDark" tabular style={styles.time}>
            {scheduleClock(car.arriveBy)}
          </Text>
        </View>
        <View style={styles.money}>
          <Text variant="caption" color="onDark2">
            Total
          </Text>
          <Text variant="title2" color="onDark" tabular>
            {formatCedis(car.farePesewas)}
          </Text>
          <Text variant="caption" color="greenOnDark" tabular>
            {`you get ${formatCedis(car.driverSharePesewas)}`}
          </Text>
        </View>
      </View>

      <View style={styles.body}>
        {car.mine && car.leaveBy ? (
          <View style={styles.leave}>
            <Ionicons name="time" size={18} color={colors.green700} />
            <Text variant="bodyStrong" color="brand">
              {leaveByLabel(Date.parse(car.leaveBy))}
            </Text>
          </View>
        ) : null}

        <View style={styles.row}>
          <Ionicons name="navigate-outline" size={18} color={colors.ink2} />
          <Text variant="bodyStrong" numberOfLines={2} style={styles.flex}>
            {`${car.pickupArea} → ${car.dropoffArea}`}
          </Text>
        </View>
        <Text variant="subhead" color="secondary">
          {[car.mine ? seatsFilledLabel(car.seats, car.carSeats) : seatsWord(car.seats), summary].filter(Boolean).join(" · ")}
        </Text>

        {car.riders.length > 0 ? (
          <View style={styles.riders}>
            {car.riders.map((r, i) => (
              <View key={`${r.firstName}-${i}`} style={styles.rider} testID={`scheduled-rider-${i}`}>
                <View style={styles.order}>
                  <Text variant="caption" color="onBrand" tabular>
                    {i + 1}
                  </Text>
                </View>
                <View style={styles.flex}>
                  <Text variant="bodyStrong" numberOfLines={1}>
                    {`${r.firstName}${r.seats > 1 ? ` · ${seatsWord(r.seats)}` : ""}${r.coming ? " · coming" : ""}`}
                  </Text>
                  <Text variant="subhead" color="secondary" numberOfLines={1}>
                    {`Pickup: ${r.pickupLabel}`}
                  </Text>
                  {allTo === null ? (
                    <Text variant="subhead" color="secondary" numberOfLines={1}>
                      {`Drop-off: ${r.dropoffLabel}`}
                    </Text>
                  ) : null}
                </View>
                <IconButton
                  icon="call"
                  variant="compact"
                  accessibilityLabel={`Call ${r.firstName}`}
                  disabled={!r.phone}
                  onPress={() => void callPhone(r.phone, r.firstName)}
                  testID={`call-rider-${i}`}
                />
              </View>
            ))}
            {allTo !== null ? (
              <View style={styles.row}>
                <Ionicons name="flag-outline" size={18} color={colors.ink2} />
                <Text variant="subhead" style={styles.flex}>{`All drop-offs: ${allTo}`}</Text>
              </View>
            ) : null}
          </View>
        ) : null}

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
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  hero: { flexDirection: "row", alignItems: "flex-end", gap: spacing[3], padding: spacing[4], backgroundColor: colors.surfaceDark },
  heroCaption: { marginTop: spacing[3] },
  time: { marginTop: 2 },
  money: { alignItems: "flex-end", gap: 2 },
  body: { padding: spacing[4], gap: spacing[3] },
  leave: { flexDirection: "row", alignItems: "center", gap: spacing[2], alignSelf: "flex-start", backgroundColor: colors.green50, borderRadius: radii.full, paddingHorizontal: spacing[3], paddingVertical: spacing[1] },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  flex: { flex: 1 },
  riders: { gap: spacing[3], paddingTop: spacing[1], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rider: { flexDirection: "row", alignItems: "center", gap: spacing[3], paddingTop: spacing[2] },
  order: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.green500, alignItems: "center", justifyContent: "center" },
});
