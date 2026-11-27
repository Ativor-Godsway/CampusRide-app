import { useEffect, useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ScheduleSlotView, TripEnd } from "@rida/shared";
import {
  MAX_SHARED_BOOKING_SEATS,
  SCHEDULE_JOIN_HINT,
  SCHEDULE_SOONER_TEXT,
  firstChoice,
  joinChips,
  needsLiveRideInstead,
  pickableSlots,
  scheduleClock,
  scheduleHour,
  scheduleHourLabel,
  scheduleHours,
  scheduleTime,
  seatsWord,
  slotTileLine,
  slotsInHour,
  tripEndBody,
  tripEndFromParams,
  tripEndParams,
} from "@rida/shared";
import {
  BackButton,
  Button,
  Chip,
  FadeIn,
  Notice,
  PressableScale,
  Screen,
  Skeleton,
  Stepper,
  Text,
  colors,
  formatCedis,
  getScheduleOptions,
  radii,
  scheduleErrorText,
  scheduleOptionsQueryKey,
  serverNow,
  spacing,
} from "@rida/mobile-shared";
import { haptics } from "../../lib/haptics";

/** Two tiles a row, so "9:20" and "Join Kofi's car · 1 seat left" always fit. */
const TILE_COLUMNS = 2;
const TILE_GAP = spacing[3];

/** The width of each tile for a row this wide. */
export function tileWidth(rowWidth: number, columns = TILE_COLUMNS, gap = TILE_GAP): number {
  return Math.floor((rowWidth - gap * (columns - 1)) / columns);
}

/**
 * Pick the time (rides/scheduled.ts), step 2 of 3 in Schedule mode (where
 * to → time → confirm). Later TODAY only, within today's service hours:
 * the join banner and "Join a car" chips, an "Arrive by" hour strip in
 * 12-hour time, wide tiles with the time big and who's going your way
 * under it, the "Bringing a friend?" stepper, then Continue to confirm.
 * Past slots and slots under 20 minutes away don't show unless there's a car
 * with a driver to join (the server marks those bookable).
 */
export default function ScheduleScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const pickup = useMemo<TripEnd | null>(() => tripEndFromParams("pickup", params), [params]);
  const dropoff = useMemo<TripEnd | null>(() => tripEndFromParams("dropoff", params), [params]);
  const [seats, setSeats] = useState(() => Math.min(MAX_SHARED_BOOKING_SEATS, Math.max(1, Number(params.seats) || 1)));
  const [hour, setHour] = useState<number | null>(null);
  /** The slot the rider picked (null until they have, or once it's gone). The button always names this one. */
  const [chosen, setChosen] = useState<{ arriveBy: string; carId: string | null } | null>(null);
  const [rowWidth, setRowWidth] = useState(0);

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
  const slots = useMemo(() => pickableSlots(data?.days.find((d) => d.day === "today")?.slots ?? [], now), [data, now]);
  const hours = useMemo(() => scheduleHours(slots, now), [slots, now]);
  const chips = useMemo(() => joinChips(slots), [slots]);
  const chosenSlot = slots.find((s) => s.arriveBy === chosen?.arriveBy) ?? null;

  // First load: a car to join, else the first slot; and its hour.
  useEffect(() => {
    if (!data || chosen) return;
    const first = firstChoice(slots);
    if (first) {
      setChosen({ arriveBy: first.arriveBy, carId: first.join?.carId ?? null });
      setHour(scheduleHour(Date.parse(first.arriveBy)));
    } else setHour(hours[0] ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // The picked slot closed or went away (a refresh): nothing is picked until the rider picks again.
  useEffect(() => {
    if (chosen && data && !chosenSlot) setChosen(null);
  }, [chosen, chosenSlot, data]);

  const tiles = hour === null ? [] : slotsInHour(slots, hour);
  const fare = data ? data.sharedBySeats[seats - 1]! : null;
  // Slots under 20 minutes away are hidden (no car to join): say a normal ride is the way to go sooner.
  const allToday = data?.days.find((d) => d.day === "today")?.slots ?? [];
  const sooner =
    data !== undefined &&
    allToday.some((s) => !s.bookable && needsLiveRideInstead(Date.parse(s.arriveBy), now, data.settings, Boolean(s.join)) && Date.parse(s.arriveBy) > now);

  const pick = (slot: ScheduleSlotView, carId: string | null = slot.join?.carId ?? null) => {
    haptics.selection();
    setChosen({ arriveBy: slot.arriveBy, carId });
    setHour(scheduleHour(Date.parse(slot.arriveBy)));
  };

  const pickHour = (h: number) => {
    haptics.selection();
    setHour(h);
    // The button must never name a time the rider can't see: another hour means picking again.
    if (chosen && scheduleHour(Date.parse(chosen.arriveBy)) !== h) setChosen(null);
  };

  function next() {
    if (!chosenSlot || fare === null || !pickup || !dropoff) return;
    router.push({
      pathname: "/ride/schedule-confirm",
      params: {
        ...tripEndParams("pickup", pickup),
        ...tripEndParams("dropoff", dropoff),
        arriveBy: chosenSlot.arriveBy,
        seats: String(seats),
        fare: String(fare),
        freeCancel: String(data?.settings.freeCancelMinutes ?? 30),
        ...(chosen?.carId && chosenSlot.join ? { carId: chosen.carId, driver: chosenSlot.join.driverFirstName } : {}),
      },
    });
  }

  const blocked = Boolean(data?.blockedText) || data?.enabled === false;
  const label = chosenSlot ? `Continue · arrive by ${scheduleClock(chosenSlot.arriveBy)}` : "Choose a time";
  const width = rowWidth > 0 ? tileWidth(rowWidth) : undefined;

  return (
    <Screen edges={["top", "bottom"]} noPadding style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BackButton />
        <Text variant="eyebrow" color="brand">
          Scheduled ride · today
        </Text>
        <Text variant="title1" accessibilityRole="header">
          When do you need to arrive?
        </Text>
        <View style={styles.route}>
          <Ionicons name="ellipse" size={10} color={colors.green500} />
          <Text variant="subhead" color="secondary" numberOfLines={1} style={styles.flex}>
            {`${pickup?.label ?? "Pickup"} → ${dropoff?.label ?? "Drop-off"} · Shared`}
          </Text>
        </View>

        {data?.blockedText ? <Notice tone="warning" icon="calendar-outline" message={data.blockedText} /> : null}
        {data && !data.enabled ? <Notice tone="warning" icon="calendar-outline" message="Scheduling isn't available right now. You can still ride now." /> : null}

        {!data && options.isError ? (
          <View style={styles.loading}>
            <Notice tone="error" icon="cloud-offline-outline" message={scheduleErrorText(options.error, "Couldn't load the times. Check your connection.")} />
            <Button label="Try again" variant="secondary" size="md" onPress={() => void options.refetch()} />
          </View>
        ) : !data ? (
          <View style={styles.loading}>
            <Skeleton width="100%" height={56} radius={radii.lg} />
            <Skeleton width="100%" height={44} />
            <Skeleton width="100%" height={160} radius={radii.lg} />
          </View>
        ) : (
          <>
            <FadeIn style={styles.banner}>
              <View style={styles.bannerIcon}>
                <Ionicons name="people" size={18} color={colors.green700} />
              </View>
              <Text variant="subhead" style={styles.bannerText}>
                {SCHEDULE_JOIN_HINT}
              </Text>
            </FadeIn>

            {chips.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {chips.map((c) => (
                  <Chip
                    key={c.arriveBy}
                    kind="choice"
                    icon={c.carId ? "car-outline" : "people-outline"}
                    label={c.label}
                    selected={chosen?.arriveBy === c.arriveBy}
                    onPress={() => {
                      const slot = slots.find((s) => s.arriveBy === c.arriveBy);
                      if (slot) pick(slot, c.carId);
                    }}
                  />
                ))}
              </ScrollView>
            ) : null}

            <Text variant="title3" accessibilityRole="header" style={styles.sectionTitle}>
              Arrive by
            </Text>
            {hours.length === 0 ? (
              <Text variant="body" color="secondary">
                No times left today. You can still ride now.
              </Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hourRow} accessibilityRole="tablist">
                {hours.map((h) => (
                  <Pressable
                    key={h}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: h === hour }}
                    accessibilityLabel={`${scheduleHourLabel(h)} hour`}
                    onPress={() => pickHour(h)}
                    style={[styles.hour, h === hour && styles.hourSelected]}
                  >
                    <Text variant="bodyStrong" style={h === hour ? styles.hourTextSelected : undefined}>
                      {scheduleHourLabel(h)}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}

            <View style={styles.tiles} onLayout={(e: LayoutChangeEvent) => setRowWidth(e.nativeEvent.layout.width)}>
              {tiles.map((slot, i) => {
                const selected = chosen?.arriveBy === slot.arriveBy;
                const line = slotTileLine(slot);
                return (
                  <FadeIn key={`${hour}-${slot.arriveBy}`} delay={i * 40} style={width ? { width } : styles.tileFallback}>
                    <PressableScale
                      onPress={() => pick(slot)}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`Arrive by ${scheduleClock(slot.arriveBy)}${line ? `, ${line}` : ""}`}
                      style={[styles.tile, line ? styles.tileGoing : null, selected && styles.tileSelected]}
                      testID={`slot-${scheduleClock(slot.arriveBy)}`}
                    >
                      <Text variant="title2" tabular numberOfLines={1} color={selected ? "brand" : "default"}>
                        {scheduleTime(slot.arriveBy)}
                      </Text>
                      <Text variant="caption" color={line ? "brand" : "tertiary"} numberOfLines={2}>
                        {line ?? scheduleClock(slot.arriveBy).slice(-2)}
                      </Text>
                    </PressableScale>
                  </FadeIn>
                );
              })}
            </View>

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
          </>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Button label={label} onPress={next} disabled={!chosenSlot || fare === null || blocked} />
        {fare !== null ? (
          <Text variant="caption" color="tertiary" style={styles.centered}>
            {`${seatsWord(seats)} · ${formatCedis(fare)} · cash on the day`}
          </Text>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: colors.surface },
  content: { padding: spacing.gutter, gap: spacing[3], paddingBottom: spacing[8] },
  route: { flexDirection: "row", alignItems: "center", gap: spacing[2] },
  flex: { flex: 1 },
  loading: { gap: spacing[3], marginTop: spacing[2] },
  banner: { flexDirection: "row", alignItems: "center", gap: spacing[3], padding: spacing[3], borderRadius: radii.lg, backgroundColor: colors.green50, marginTop: spacing[2] },
  bannerIcon: { width: 32, height: 32, borderRadius: radii.full, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center" },
  bannerText: { flex: 1, color: colors.green700 },
  chipRow: { gap: spacing[2], paddingVertical: spacing[1] },
  sectionTitle: { marginTop: spacing[3] },
  hourRow: { gap: spacing[2] },
  hour: { minWidth: 64, height: 44, paddingHorizontal: spacing[4], borderRadius: radii.full, backgroundColor: colors.surface2, alignItems: "center", justifyContent: "center" },
  hourSelected: { backgroundColor: colors.ink },
  hourTextSelected: { color: colors.onDark },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: TILE_GAP, marginTop: spacing[1] },
  tileFallback: { width: "47%" },
  tile: {
    minHeight: 80,
    borderRadius: radii.lg,
    backgroundColor: colors.surface2,
    borderWidth: 2,
    borderColor: "transparent",
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    justifyContent: "center",
    gap: 2,
  },
  tileGoing: { backgroundColor: colors.green50 },
  tileSelected: { borderColor: colors.green500, backgroundColor: colors.green50 },
  sooner: { flexDirection: "row", alignItems: "center", gap: spacing[2], padding: spacing[3], borderRadius: radii.md, backgroundColor: colors.green50 },
  soonerText: { flex: 1, color: colors.green700 },
  seatsRow: { flexDirection: "row", alignItems: "center", marginTop: spacing[3] },
  footer: { paddingHorizontal: spacing.gutter, paddingTop: spacing[3], paddingBottom: spacing[2], gap: spacing[1], borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  centered: { textAlign: "center" },
});
