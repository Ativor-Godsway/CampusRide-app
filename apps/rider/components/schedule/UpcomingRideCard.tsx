import { useEffect, useRef, useState } from "react";
import { Alert, Animated, Easing, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import {
  SCHEDULED_STATE_LABELS,
  carWords,
  pickupWindowLabel,
  scheduleClock,
  scheduleWhen,
  seatsFilledLabel,
  type ScheduledBookingView,
} from "@rida/shared";
import {
  Button,
  StatusChip,
  Text,
  cancelScheduledRide,
  colors,
  formatCedis,
  myScheduledRideQueryKey,
  radii,
  sayImComing,
  scheduleErrorText,
  serverNow,
  spacing,
  useReduceMotion,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

/** The cancel question's words: free, or a strike (rides/scheduled.ts). */
export function cancelQuestion(booking: Pick<ScheduledBookingView, "freeCancelUntil">, now: number): string {
  return now <= Date.parse(booking.freeCancelUntil)
    ? "Cancelling is free. Your seat goes to someone else."
    : "It's close to your ride, so this cancel counts as a strike. 2 strikes stop scheduling for 7 days.";
}

/** The car's seats as four marks, filled ones green, filling in smoothly as riders join. */
function SeatMarks({ taken, capacity }: { taken: number; capacity: number }) {
  const reduceMotion = useReduceMotion();
  const fill = useRef(new Animated.Value(taken)).current;
  useEffect(() => {
    if (reduceMotion) {
      fill.setValue(taken);
      return;
    }
    const anim = Animated.timing(fill, { toValue: taken, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: false });
    anim.start();
    return () => anim.stop();
  }, [taken, fill, reduceMotion]);
  return (
    <View style={styles.seats} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: capacity }, (_, i) => (
        <Animated.View
          key={i}
          style={[
            styles.seat,
            { backgroundColor: fill.interpolate({ inputRange: [i, i + 1], outputRange: [colors.surface3, colors.green500], extrapolate: "clamp" }) },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * The rider's upcoming scheduled ride on Home: when, seats filled (3 of 4),
 * the status (Waiting for riders / Car confirmed / Driver on the way), the
 * driver and car once one accepted, the pickup window, "I'm coming", Cancel.
 */
export function UpcomingRideCard({ booking, onTrack }: { booking: ScheduledBookingView; onTrack?: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<"coming" | "cancel" | null>(null);
  const now = serverNow();
  const state = booking.state;
  const confirmed = state === "CAR_CONFIRMED" || state === "DRIVER_ON_THE_WAY";
  const car = booking.driver ? carWords({ color: booking.driver.carColor, make: booking.driver.carMake, model: booking.driver.carModel }) : null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: myScheduledRideQueryKey });

  async function coming() {
    setBusy("coming");
    try {
      await sayImComing(booking.id);
      haptics.success();
      await refresh();
    } catch (err) {
      Alert.alert("Couldn't let your driver know", scheduleErrorText(err));
    } finally {
      setBusy(null);
    }
  }

  function cancel() {
    Alert.alert(`Cancel your ${scheduleClock(booking.arriveBy)} ride?`, cancelQuestion(booking, now), [
      { text: "Keep it", style: "cancel" },
      {
        text: "Cancel ride",
        style: "destructive",
        onPress: () => {
          setBusy("cancel");
          void cancelScheduledRide(booking.id)
            .then(() => refresh())
            .catch((err) => Alert.alert("Couldn't cancel", scheduleErrorText(err)))
            .finally(() => setBusy(null));
        },
      },
    ]);
  }

  return (
    <View style={styles.card} accessibilityLabel={`Scheduled ride, arrive by ${scheduleWhen(Date.parse(booking.arriveBy), now)}, ${SCHEDULED_STATE_LABELS[state]}`}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text variant="eyebrow" color="secondary">
            {`Scheduled · arrive by ${scheduleWhen(Date.parse(booking.arriveBy), now)}`}
          </Text>
          <Text variant="bodyStrong" numberOfLines={1}>
            {`${booking.pickupLabel} → ${booking.dropoffLabel}`}
          </Text>
        </View>
        <StatusChip label={SCHEDULED_STATE_LABELS[state]} tone={confirmed ? "brand" : "neutral"} icon={confirmed ? "checkmark-circle" : "time-outline"} />
      </View>

      <View style={styles.row}>
        <SeatMarks taken={booking.carSeatsTaken} capacity={booking.carSeats} />
        <Text variant="subhead" color="secondary" style={styles.flex}>
          {seatsFilledLabel(booking.carSeatsTaken, booking.carSeats)}
        </Text>
        <Text variant="subhead" tabular>
          {formatCedis(booking.farePesewas)}
        </Text>
      </View>

      {booking.driver ? (
        <View style={styles.row}>
          <Ionicons name="car-outline" size={18} color={colors.ink2} />
          <Text variant="subhead" style={styles.flex} numberOfLines={1}>
            {[booking.driver.firstName, car, booking.driver.plate].filter(Boolean).join(" · ")}
          </Text>
        </View>
      ) : null}
      {booking.pickupWindow ? (
        <View style={styles.row}>
          <Ionicons name="time-outline" size={18} color={colors.ink2} />
          <Text variant="subhead" style={styles.flex}>
            {`Be ready ${pickupWindowLabel({ start: Date.parse(booking.pickupWindow.start), end: Date.parse(booking.pickupWindow.end) })} at ${booking.pickupLabel}`}
          </Text>
        </View>
      ) : (
        <Text variant="caption" color="tertiary">
          We confirm your driver as the car fills, and remind you before pickup.
        </Text>
      )}

      <View style={styles.actions}>
        {state === "DRIVER_ON_THE_WAY" && onTrack ? (
          <View style={styles.flex}>
            <Button label="Track your driver" size="md" onPress={onTrack} />
          </View>
        ) : null}
        {confirmed && booking.status === "BOOKED" ? (
          booking.coming ? (
            <View style={[styles.coming, styles.flex]}>
              <Ionicons name="checkmark-circle" size={18} color={colors.green700} />
              <Text variant="subhead" style={styles.comingText}>
                Your driver knows you're coming
              </Text>
            </View>
          ) : (
            <View style={styles.flex}>
              <Button label="I'm coming" variant="secondary" size="md" icon="walk-outline" loading={busy === "coming"} onPress={() => void coming()} />
            </View>
          )
        ) : null}
        {booking.status === "BOOKED" ? <Button label="Cancel" variant="text" size="md" fullWidth={false} loading={busy === "cancel"} onPress={cancel} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.lg, backgroundColor: colors.surface2, padding: spacing[4], gap: spacing[3] },
  head: { flexDirection: "row", alignItems: "flex-start", gap: spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  flex: { flex: 1 },
  seats: { flexDirection: "row", gap: 4 },
  seat: { width: 14, height: 14, borderRadius: 7 },
  actions: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  coming: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  comingText: { color: colors.green700 },
});
