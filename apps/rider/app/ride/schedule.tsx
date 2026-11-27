import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScheduleDay, ScheduleSlotView, TripEnd } from "@rida/shared";
import {
  MAX_SHARED_BOOKING_SEATS,
  SCHEDULE_JOIN_HINT,
  SCHEDULE_SOONER_TEXT,
  firstChoice,
  joinChips,
  needsLiveRideInstead,
  reserveButtonLabel,
  scheduleClock,
  scheduleDayWord,
  scheduleHours,
  seatsWord,
  slotsInHour,
  tripEndBody,
  tripEndFromParams,
} from "@rida/shared";
import {
  BackButton,
  Button,
  Chip,
  FadeIn,
  Notice,
  PressableScale,
  Screen,
  SegmentedControl,
  Skeleton,
  Stepper,
  Text,
  bookScheduledRide,
  colors,
  formatCedis,
  getScheduleOptions,
  goHome,
  myScheduledRideQueryKey,
  radii,
  scheduleErrorCode,
  scheduleErrorText,
  scheduleOptionsQueryKey,
  serverNow,
  spacing,
  spokenCedis,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

/**
 * Schedule a Shared ride (rides/scheduled.ts): Today / Tomorrow, "Join a car"
 * chips for slots with people going the rider's way, then an hour strip and
 * that hour's arrive-by tiles (a green dot where others are going your way),
 * the "Bringing a friend?" stepper, and "Reserve seat · 9:00 · GH₵7".
 * Reached from Choose a ride ("Schedule for later") with the same two ends.
 */
export default function ScheduleScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<Record<string, string>>();
  const pickup = useMemo<TripEnd | null>(() => tripEndFromParams("pickup", params), [params]);
  const dropoff = useMemo<TripEnd | null>(() => tripEndFromParams("dropoff", params), [params]);
  const [seats, setSeats] = useState(() => Math.min(MAX_SHARED_BOOKING_SEATS, Math.max(1, Number(params.seats) || 1)));
  const [day, setDay] = useState<ScheduleDay>("today");
  const [hour, setHour] = useState<number | null>(null);
  const [chosen, setChosen] = useState<{ arriveBy: string; carId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const pickupBody = pickup ? tripEndBody(pickup) : null;
  const dropoffBody = dropoff ? tripEndBody(dropoff) : null;
  const options = useQuery({
    queryKey: pickupBody && dropoffBody ? scheduleOptionsQueryKey(pickupBody, dropoffBody, seats) : ["schedule", "options", "none"],
    queryFn: () => getScheduleOptions(pickupBody!, dropoffBody!, seats),
    enabled: pickupBody !== null && dropoffBody !== null,
    refetchInterval: 60_000,
  });
  const data = options.data;
  const now = serverNow();
  const daySlots: ScheduleSlotView[] = useMemo(() => data?.days.find((d) => d.day === day)?.slots ?? [], [data, day]);
  const hours = useMemo(() => scheduleHours(daySlots, now), [daySlots, now]);
  const chips = useMemo(() => joinChips(daySlots), [daySlots]);

  // Tonight there's nothing left today: start on Tomorrow.
  useEffect(() => {
    if (!data || day !== "today") return;
    const today = data.days.find((d) => d.day === "today")?.slots ?? [];
    if (!today.some((s) => s.bookable)) setDay("tomorrow");
  }, [data, day]);

  // A sensible first choice for the day: a car to join, else the first open slot.
  useEffect(() => {
    if (!data) return;
    if (chosen && daySlots.some((s) => s.arriveBy === chosen.arriveBy && s.bookable)) return;
    const first = firstChoice(daySlots);
    setChosen(first ? { arriveBy: first.arriveBy, carId: first.join?.carId ?? null } : null);
    setHour(first ? new Date(first.arriveBy).getUTCHours() : (hours[0] ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, day]);

  const tiles = hour === null ? [] : slotsInHour(daySlots, hour);
  const chosenSlot = daySlots.find((s) => s.arriveBy === chosen?.arriveBy) ?? null;
  const fare = data ? data.sharedBySeats[seats - 1]! : null;
  const sooner =
    data && chosenSlot ? needsLiveRideInstead(Date.parse(chosenSlot.arriveBy), now, data.settings, Boolean(chosenSlot.join)) : false;

  const choose = (slot: ScheduleSlotView, carId: string | null = slot.join?.carId ?? null) => {
    haptics.selection();
    setChosen({ arriveBy: slot.arriveBy, carId });
    setHour(new Date(slot.arriveBy).getUTCHours());
  };

  async function reserve() {
    if (!chosen || !pickupBody || !dropoffBody || fare === null) return;
    setBusy(true);
    try {
      await bookScheduledRide({ arriveBy: chosen.arriveBy, pickup: pickupBody, dropoff: dropoffBody, seats, shownFarePesewas: fare, carId: chosen.carId });
      haptics.success();
      await queryClient.invalidateQueries({ queryKey: myScheduledRideQueryKey });
      goHome(router);
    } catch (err) {
      const code = scheduleErrorCode(err);
      if (code === "FARE_CHANGED" || code === "SLOT_CLOSED") void options.refetch();
      Alert.alert(code === "SLOT_CLOSED" ? "That time has closed" : "Couldn't reserve", scheduleErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const label = chosen && fare !== null ? reserveButtonLabel(Date.parse(chosen.arriveBy), seats, fare) : "Choose a time";

  return (
    <Screen edges={["top", "bottom"]} noPadding style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BackButton />
        <Text variant="title1" accessibilityRole="header">
          Schedule a ride
        </Text>
        <Text variant="subhead" color="secondary" numberOfLines={2}>
          {`${pickup?.label ?? "Pickup"} → ${dropoff?.label ?? "Drop-off"} · Shared`}
        </Text>

        {data?.blockedText ? <Notice tone="warning" icon="calendar-outline" message={data.blockedText} /> : null}
        {data && !data.enabled ? <Notice tone="warning" icon="calendar-outline" message="Scheduling isn't available right now. You can still ride now." /> : null}

        <SegmentedControl
          options={[
            { value: "today", label: scheduleDayWord("today") },
            { value: "tomorrow", label: scheduleDayWord("tomorrow") },
          ]}
          value={day}
          onChange={(d) => {
            haptics.selection();
            setDay(d);
          }}
          accessibilityLabel="Day"
        />

        {!data && options.isError ? (
          <View style={styles.loading}>
            <Notice tone="error" icon="cloud-offline-outline" message={scheduleErrorText(options.error, "Couldn't load the times. Check your connection.")} />
            <Button label="Try again" variant="secondary" size="md" onPress={() => void options.refetch()} />
          </View>
        ) : !data ? (
          <View style={styles.loading}>
            <Skeleton width="100%" height={44} />
            <Skeleton width="100%" height={120} />
          </View>
        ) : (
          <>
            {chips.length > 0 ? (
              <FadeIn>
                <Text variant="eyebrow" color="secondary" style={styles.sectionLabel}>
                  Join a car
                </Text>
                <Text variant="subhead" color="secondary">
                  {SCHEDULE_JOIN_HINT}
                </Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                  {chips.map((c) => (
                    <Chip
                      key={c.arriveBy}
                      kind="choice"
                      icon={c.carId ? "car-outline" : "people-outline"}
                      label={c.label}
                      selected={chosen?.arriveBy === c.arriveBy}
                      onPress={() => {
                        const slot = daySlots.find((s) => s.arriveBy === c.arriveBy);
                        if (slot) choose(slot, c.carId);
                      }}
                    />
                  ))}
                </ScrollView>
              </FadeIn>
            ) : null}

            <Text variant="eyebrow" color="secondary" style={styles.sectionLabel}>
              Arrive by
            </Text>
            {hours.length === 0 ? (
              <Text variant="body" color="secondary">
                No times left {day === "today" ? "today. Try tomorrow." : "tomorrow."}
              </Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hourRow} accessibilityRole="tablist">
                {hours.map((h) => (
                  <Pressable
                    key={h}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: h === hour }}
                    accessibilityLabel={`${h}:00 hour`}
                    onPress={() => {
                      haptics.selection();
                      setHour(h);
                    }}
                    style={[styles.hour, h === hour && styles.hourSelected]}
                  >
                    <Text variant="bodyStrong" style={h === hour ? styles.hourTextSelected : undefined}>
                      {h}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <FadeIn key={`${day}-${hour}`} style={styles.tiles}>
              {tiles.map((slot) => {
                const selected = chosen?.arriveBy === slot.arriveBy;
                const going = slot.going > 0 || slot.join !== null;
                return (
                  <PressableScale
                    key={slot.arriveBy}
                    // A closed slot still answers (it says "Need a ride sooner?"); a past one doesn't.
                    disabled={Date.parse(slot.arriveBy) <= now}
                    onPress={() => choose(slot)}
                    accessibilityRole="button"
                    accessibilityState={{ selected, disabled: !slot.bookable }}
                    accessibilityLabel={`Arrive by ${scheduleClock(slot.arriveBy)}${going ? `, ${slot.going} going your way` : ""}${slot.bookable ? "" : ", closed"}`}
                    style={[styles.tile, selected && styles.tileSelected, !slot.bookable && styles.tileClosed]}
                    testID={`slot-${scheduleClock(slot.arriveBy)}`}
                  >
                    <Text variant="bodyStrong" color={slot.bookable ? (selected ? "brand" : "default") : "tertiary"} tabular>
                      {scheduleClock(slot.arriveBy)}
                    </Text>
                    {going && slot.bookable ? <View style={styles.dot} accessibilityElementsHidden /> : null}
                  </PressableScale>
                );
              })}
            </FadeIn>

            {sooner ? (
              <FadeIn style={styles.sooner}>
                <Ionicons name="flash-outline" size={18} color={colors.green700} />
                <Text variant="subhead" style={styles.soonerText}>
                  {SCHEDULE_SOONER_TEXT}
                </Text>
                <Button label="Book now" variant="text" size="pill" onPress={() => router.back()} accessibilityHint="Back to Choose a ride" />
              </FadeIn>
            ) : null}

            <View style={styles.seatsRow}>
              <Text variant="subhead" color="secondary" style={styles.flex}>
                Bringing a friend?
              </Text>
              <Stepper value={seats} min={1} max={MAX_SHARED_BOOKING_SEATS} format={seatsWord} onChange={setSeats} accessibilityLabel="Seats in this booking" testID="schedule-seats" />
            </View>
            <Text variant="caption" color="tertiary">
              {`Cash on the day. Free to cancel until ${data.settings.freeCancelMinutes} minutes before.`}
            </Text>
          </>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Button
          label={label}
          onPress={() => void reserve()}
          disabled={!chosen || !chosenSlot?.bookable || fare === null || Boolean(data?.blockedText) || data?.enabled === false}
          loading={busy}
          accessibilityHint={fare !== null ? `${seatsWord(seats)}, ${spokenCedis(fare)}, paid in cash` : undefined}
        />
        {fare !== null && seats > 1 ? (
          <Text variant="caption" color="tertiary" style={styles.centered}>
            {`${seatsWord(seats)} · ${formatCedis(fare)} in all`}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.surface },
  content: { padding: spacing.gutter, gap: spacing[4], paddingBottom: spacing[8] },
  loading: { gap: spacing[3] },
  sectionLabel: { marginTop: spacing[2] },
  chipRow: { gap: spacing[2], paddingVertical: spacing[2] },
  hourRow: { gap: spacing[2] },
  hour: {
    minWidth: 48,
    height: 44,
    paddingHorizontal: spacing[3],
    borderRadius: radii.full,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  hourSelected: { backgroundColor: colors.ink },
  hourTextSelected: { color: colors.onDark },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: spacing[2] },
  tile: {
    width: "31.5%",
    height: 56,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  tileSelected: { backgroundColor: colors.green50, borderColor: colors.green500 },
  tileClosed: { opacity: 0.5 },
  dot: { position: "absolute", top: 8, right: 10, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green500 },
  sooner: { flexDirection: "row", alignItems: "center", gap: spacing[2], padding: spacing[3], borderRadius: radii.md, backgroundColor: colors.green50 },
  soonerText: { flex: 1, color: colors.green700 },
  seatsRow: { flexDirection: "row", alignItems: "center", marginTop: spacing[2] },
  flex: { flex: 1 },
  footer: { paddingHorizontal: spacing.gutter, paddingTop: spacing[3], paddingBottom: spacing[2], gap: spacing[1], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  centered: { textAlign: "center" },
});
