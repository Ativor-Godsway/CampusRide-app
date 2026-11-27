import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Image, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { TripEnd } from "@rida/shared";
import { scheduledConfirmLine, seatsWord, tripEndBody, tripEndFromParams } from "@rida/shared";
import {
  BackButton,
  Button,
  FadeIn,
  Screen,
  Text,
  bookScheduledRide,
  colors,
  formatCedis,
  goHome,
  illustrations,
  myScheduledRideQueryKey,
  radii,
  scheduleErrorCode,
  scheduleErrorText,
  serverNow,
  spacing,
  spokenCedis,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

/** The Reserve button: "Reserve seat · GH₵7", "Reserve 2 seats · GH₵14". */
export function reserveLabel(seats: number, fare: number): string {
  return `${seats > 1 ? `Reserve ${seats} seats` : "Reserve seat"} · ${formatCedis(fare)}`;
}

/**
 * Confirm a scheduled ride, step 3 of 3: "Scheduled · arrive by 9:20 AM ·
 * Today", the trip, seats, the car to join if one was picked, the price
 * (cash on the day) and the free-cancel rule, then Reserve.
 */
export default function ScheduleConfirmScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<Record<string, string>>();
  const pickup = useMemo<TripEnd | null>(() => tripEndFromParams("pickup", params), [params]);
  const dropoff = useMemo<TripEnd | null>(() => tripEndFromParams("dropoff", params), [params]);
  const seats = Math.max(1, Number(params.seats) || 1);
  const fare = Number(params.fare) || 0;
  const arriveBy = Date.parse(params.arriveBy ?? "");
  const [busy, setBusy] = useState(false);

  async function reserve() {
    if (!pickup || !dropoff || !Number.isFinite(arriveBy)) return;
    setBusy(true);
    try {
      await bookScheduledRide({
        arriveBy: new Date(arriveBy).toISOString(),
        pickup: tripEndBody(pickup),
        dropoff: tripEndBody(dropoff),
        seats,
        shownFarePesewas: fare,
        carId: params.carId ?? null,
      });
      haptics.success();
      await queryClient.invalidateQueries({ queryKey: myScheduledRideQueryKey });
      goHome(router);
    } catch (err) {
      const code = scheduleErrorCode(err);
      Alert.alert(code === "SLOT_CLOSED" ? "That time has closed" : code === "FARE_CHANGED" ? "The price changed" : "Couldn't reserve", scheduleErrorText(err), [
        { text: "Choose again", onPress: () => router.back() },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={["top", "bottom"]} noPadding style={styles.page}>
      <ScrollView contentContainerStyle={styles.content}>
        <BackButton />
        <FadeIn style={styles.hero}>
          <Image source={illustrations.carShared} style={styles.art} resizeMode="contain" accessibilityIgnoresInvertColors />
          <View style={styles.badge}>
            <Ionicons name="calendar" size={16} color={colors.onBrand} />
            <Text variant="bodyStrong" color="onBrand">
              {Number.isFinite(arriveBy) ? scheduledConfirmLine(arriveBy, serverNow()) : "Scheduled"}
            </Text>
          </View>
        </FadeIn>
        <Text variant="title1" accessibilityRole="header">
          Confirm your scheduled ride
        </Text>

        <FadeIn delay={80} style={styles.card}>
          <View style={styles.stop}>
            <View style={[styles.dot, { backgroundColor: colors.green500 }]} />
            <View style={styles.flex}>
              <Text variant="caption" color="tertiary">
                Pickup
              </Text>
              <Text variant="bodyStrong">{pickup?.label ?? "Pickup"}</Text>
            </View>
          </View>
          <View style={styles.line} />
          <View style={styles.stop}>
            <View style={[styles.dot, { backgroundColor: colors.ink }]} />
            <View style={styles.flex}>
              <Text variant="caption" color="tertiary">
                Drop-off
              </Text>
              <Text variant="bodyStrong">{dropoff?.label ?? "Drop-off"}</Text>
            </View>
          </View>
        </FadeIn>

        <FadeIn delay={140} style={styles.facts}>
          <Fact icon="people-outline" text={`Shared · ${seatsWord(seats)}`} />
          {params.driver ? <Fact icon="car-outline" text={`Joining ${params.driver}'s car`} /> : <Fact icon="car-outline" text="We confirm your driver as the car fills" />}
          <Fact icon="cash-outline" text={`${formatCedis(fare)} · cash on the day`} />
          <Fact icon="notifications-outline" text="We remind you before pickup" />
          <Fact icon="close-circle-outline" text={`Free to cancel until ${Number(params.freeCancel) || 30} minutes before`} />
        </FadeIn>
      </ScrollView>
      <View style={styles.footer}>
        <Button
          label={reserveLabel(seats, fare)}
          loading={busy}
          onPress={() => void reserve()}
          accessibilityHint={`${seatsWord(seats)}, ${spokenCedis(fare)}, paid in cash`}
        />
      </View>
    </Screen>
  );
}

function Fact({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.fact}>
      <Ionicons name={icon} size={20} color={colors.ink2} />
      <Text variant="subhead" style={styles.flex}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.surface },
  content: { padding: spacing.gutter, gap: spacing[4], paddingBottom: spacing[8] },
  hero: { alignItems: "center", gap: spacing[3] },
  art: { width: 220, height: 130 },
  badge: { flexDirection: "row", alignItems: "center", gap: spacing[2], backgroundColor: colors.green500, borderRadius: radii.full, paddingHorizontal: spacing[4], paddingVertical: spacing[2] },
  card: { borderRadius: radii.lg, backgroundColor: colors.surface2, padding: spacing[4] },
  stop: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  dot: { width: 12, height: 12, borderRadius: 6 },
  line: { width: 2, height: 18, backgroundColor: colors.line, marginLeft: 5, marginVertical: 2 },
  flex: { flex: 1 },
  facts: { gap: spacing[3] },
  fact: { flexDirection: "row", alignItems: "center", gap: spacing[3] },
  footer: { paddingHorizontal: spacing.gutter, paddingTop: spacing[3], paddingBottom: spacing[2], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
});
