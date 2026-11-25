import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import {
  BOARD_ALL,
  boardDropoffChips,
  boardPickupChips,
  boardTakeSummary,
  filterBoard,
  formatDistance,
  planBoardTake,
  settleBoardFilter,
  spokenCedis,
} from "@rida/shared";
import {
  Button,
  Card,
  Chip,
  EmptyState,
  LoadingState,
  Screen,
  StatusChip,
  Text,
  colors,
  formatCedis,
  haptics,
  radii,
  spacing,
  useToast,
  type BoardRideItem,
} from "@rida/mobile-shared";
import { useDriverPresence } from "../../lib/presence";
import { refreshAfterTake, takeFromBoard, useRequestBoard } from "../../lib/board";

/** "Waiting 3 min" (or "Waiting <1 min"). */
function waiting(since: string, now: number): string {
  const mins = Math.floor((now - Date.parse(since)) / 60_000);
  return !Number.isFinite(mins) || mins < 1 ? "Waiting <1 min" : `Waiting ${mins} min`;
}

function kind(item: BoardRideItem): string {
  const seats = item.seats ?? 1;
  return item.type === "LONE" ? "Ride alone" : `Shared · ${seats} seat${seats === 1 ? "" : "s"}`;
}

/**
 * The request board (2026-11-25): every request on campus still waiting
 * for a driver, an EXTRA to the offer pop-ups (unchanged). Filter by pickup,
 * then drop-off; pick several and "Add to my trip" — the same accept and add
 * the rest of the app uses, so the car's limits apply (4 riders, no one into
 * a Ride alone trip). Works during a trip too: a driver passing JQB filters
 * pickup = JQB and adds who fits. Live over the socket (lib/board).
 */
export default function RequestsScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { isOnline, position } = useDriverPresence();
  const board = useRequestBoard(isOnline, position);
  const { showToast, toast } = useToast();
  const [filter, setFilter] = useState({ pickup: BOARD_ALL, dropoff: BOARD_ALL });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const rides = useMemo(() => board.data?.rides ?? [], [board.data]);
  const car = board.data?.car ?? null;
  const shown = settleBoardFilter(rides, filter);
  const pickupChips = boardPickupChips(rides);
  const dropoffChips = shown.pickup === BOARD_ALL ? [] : boardDropoffChips(rides, shown.pickup);
  const list = filterBoard(rides, shown);

  // A request that left the board leaves the selection too.
  useEffect(() => {
    setSelected((s) => {
      const still = new Set([...s].filter((id) => rides.some((r) => r.rideId === id && r.boardCanTake)));
      return still.size === s.size ? s : still;
    });
  }, [rides]);

  const chosen = rides.filter((r) => selected.has(r.rideId));
  const plan = planBoardTake(chosen, car ? { rideId: car.rideId, type: car.type, freeSeats: car.freeSeats } : null);

  const toggle = (item: BoardRideItem) => {
    if (!item.boardCanTake || busy) return;
    haptics.selection();
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(item.rideId)) next.delete(item.rideId);
      else next.add(item.rideId);
      return next;
    });
  };

  async function take() {
    if (!plan.ok || busy) return;
    setBusy(true);
    try {
      const { results, tripId } = await takeFromBoard(plan, rides, car, position);
      const added = results.some((r) => r.outcome === "added");
      if (added) haptics.success();
      showToast({ message: boardTakeSummary(results), tone: added ? "success" : "info", icon: added ? "checkmark-circle" : "information-circle" });
      setSelected(new Set());
      refreshAfterTake(queryClient);
      if (added && tripId) router.push(`/ride/${tripId}`);
    } finally {
      setBusy(false);
    }
  }

  if (!isOnline) {
    return (
      <Screen edges={["top"]}>
        <EmptyState title="Go online to see requests" message="Every request on campus that is still waiting for a driver shows here while you're online." />
      </Screen>
    );
  }
  if (board.isPending) {
    return (
      <Screen edges={["top"]}>
        <LoadingState />
      </Screen>
    );
  }
  if (board.data && !board.data.open) {
    return (
      <Screen edges={["top"]}>
        <EmptyState title="CampusRide is closed" message="Requests show here again when CampusRide opens." />
      </Screen>
    );
  }

  const tripLine = car
    ? car.type === "LONE"
      ? "You're on a Ride alone trip: no one else can join it."
      : car.freeSeats === 0
        ? "Your car is full."
        : `On a Shared trip · ${car.freeSeats} free seat${car.freeSeats === 1 ? "" : "s"}. Pick riders on your way.`
    : null;

  return (
    <Screen edges={["top"]} noPadding style={styles.screen}>
      <View style={styles.header}>
        <Text variant="title2" accessibilityRole="header">
          Requests
        </Text>
        <Text variant="subhead" color="secondary">
          Everyone on campus still waiting for a driver
        </Text>
        {tripLine ? (
          <Text variant="subhead" color="brand">
            {tripLine}
          </Text>
        ) : null}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityLabel="Pickup">
        {pickupChips.map((c) => (
          <Chip
            key={c.key}
            label={`${c.label} (${c.count})`}
            selected={shown.pickup === c.key}
            onPress={() => setFilter({ pickup: c.key, dropoff: BOARD_ALL })}
          />
        ))}
      </ScrollView>
      {dropoffChips.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityLabel="Drop-off">
          {dropoffChips.map((c) => (
            <Chip
              key={c.key}
              label={c.key === BOARD_ALL ? `Any drop-off (${c.count})` : `To ${c.label} (${c.count})`}
              selected={shown.dropoff === c.key}
              onPress={() => setFilter({ ...shown, dropoff: c.key })}
            />
          ))}
        </ScrollView>
      ) : null}

      <FlatList
        data={list}
        keyExtractor={(r) => r.rideId}
        contentContainerStyle={styles.list}
        refreshControl={<RefreshControl refreshing={board.isRefetching} onRefresh={() => void board.refetch()} />}
        ListEmptyComponent={<EmptyState title="No one is waiting" message="New requests appear here the moment riders ask." />}
        renderItem={({ item }) => {
          const on = selected.has(item.rideId);
          const from = item.pickupPlaceName ?? item.pickupZoneName;
          const to = item.dropoffPlaceName ?? item.dropoffZoneName;
          const distance = item.pickupDistanceMeters != null ? formatDistance(item.pickupDistanceMeters) : null;
          return (
            <Pressable
              onPress={() => toggle(item)}
              disabled={!item.boardCanTake || busy}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: !item.boardCanTake }}
              accessibilityLabel={`${kind(item)}, ${from} to ${to}, ${spokenCedis(item.farePesewas)}, ${waiting(item.searchingSince, now)}${distance ? `, ${distance} away` : ""}${item.boardNote ? `. ${item.boardNote}` : ""}`}
            >
              <Card variant="filled" style={[styles.card, on && styles.cardOn, !item.boardCanTake && styles.cardOff]}>
                <View style={styles.row}>
                  <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={item.boardCanTake ? colors.green500 : colors.ink3} />
                  <StatusChip label={kind(item)} tone={item.type === "SHARED" ? "brand" : "neutral"} />
                  {distance ? (
                    <Text variant="subhead" color="secondary">
                      {distance}
                    </Text>
                  ) : null}
                  <View style={styles.spacer} />
                  <Text variant="title3" tabular>
                    {formatCedis(item.farePesewas)}
                  </Text>
                </View>
                <Text variant="bodyStrong">
                  {from} → {to}
                </Text>
                <Text variant="subhead" color="secondary">
                  {[item.riderFirstName, waiting(item.searchingSince, now)].filter(Boolean).join(" · ")}
                </Text>
                {item.boardNote ? (
                  <Text variant="subhead" color="tertiary">
                    {item.boardNote}
                  </Text>
                ) : null}
              </Card>
            </Pressable>
          );
        }}
      />

      {chosen.length > 0 ? (
        <View style={styles.bar}>
          {!plan.ok ? (
            <Text variant="subhead" color="secondary" accessibilityLiveRegion="polite">
              {plan.message}
            </Text>
          ) : null}
          <Button
            label={car ? `Add to my trip (${chosen.length})` : chosen.length === 1 ? "Accept request" : `Add to my trip (${chosen.length})`}
            onPress={() => void take()}
            loading={busy}
            disabled={!plan.ok}
          />
        </View>
      ) : null}
      {toast}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: { paddingHorizontal: spacing.gutter, paddingTop: spacing[4], gap: spacing[1] },
  chips: { paddingHorizontal: spacing.gutter, paddingVertical: spacing[2], gap: spacing[2] },
  list: { paddingHorizontal: spacing.gutter, paddingBottom: 120, gap: spacing[3] },
  card: { gap: spacing[2], borderWidth: 2, borderColor: "transparent", borderRadius: radii.lg },
  cardOn: { borderColor: colors.green500 },
  cardOff: { opacity: 0.6 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2], flexWrap: "wrap" },
  spacer: { flex: 1 },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.gutter,
    gap: spacing[2],
    backgroundColor: colors.surface,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
