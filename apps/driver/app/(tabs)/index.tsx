import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { FlatList, Pressable, RefreshControl, StyleSheet, Switch, View } from "react-native";
import {
  CAR_SEATS,
  DRIVER_EVENTS,
  filterRequestsByType,
  getSharedFarePerRider,
  sortRequestsNearestFirst,
  type RequestTypeFilter,
} from "@rida/shared";
import {
  Illustration,
  LoadingState,
  Screen,
  Text,
  colors,
  getFillSuggestions,
  getRideSocket,
  radii,
  spacing,
  typography,
  useAuth,
} from "@rida/mobile-shared";
import { markTripOpened, useDriverActiveTrip, wasTripOpened } from "../../lib/activeTrip";
import { useDriverPresence } from "../../lib/presence";
import { useRequestsNearYou } from "../../lib/requests";
import { overlayPassengers, runAddRider, runClaim, useTripActions } from "../../lib/tripActions";
import { useZones } from "../../lib/zones";
import { RequestCard, type HomeRequest } from "../../components/home/RequestCard";

const FILTERS: { value: RequestTypeFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "SHARED", label: "Shared" },
  { value: "LONE", label: "Private" },
];

/**
 * Home — where requests live.
 *
 * - Header: greeting and the Online switch.
 * - On a trip, the green trip banner sits above everything (from the tabs
 *   layout, identical on every tab).
 * - Free: every request near you, nearest first, filtered by type, with
 *   Accept. Accepting opens the trip at once (lib/tripActions).
 * - On a Shared trip: only riders who fit the route, each with See route
 *   (the dotted preview on the trip screen) and Add.
 * - On a Ride-alone trip: no requests, and a line saying why.
 * - No requests: the pulsing pin. Offline: "Ready when you are".
 *
 * The list updates live (new requests arrive over the socket; it also polls),
 * and a request you accept or add leaves the list the moment you tap.
 */
export default function DriverHomeScreen() {
  const router = useRouter();
  const { isLoading: authLoading, user } = useAuth();
  const { isOnline, waking, outsideServiceArea, position, toggle } = useDriverPresence();
  const { data: trip, isLoading: tripLoading } = useDriverActiveTrip();
  const actions = useTripActions();
  const { data: zones = [] } = useZones();
  const [filter, setFilter] = useState<RequestTypeFilter>("ALL");

  // Open a trip's screen once per trip (one started elsewhere, or the app
  // reopened mid-trip). After that, the banner leads back.
  useEffect(() => {
    if (!trip || wasTripOpened(trip.id)) return;
    markTripOpened(trip.id);
    router.push(`/ride/${trip.id}`);
  }, [trip, router]);

  // ─── Requests when free ─────────────────────────────────────────────────
  const free = isOnline && !trip;
  const eligible = useRequestsNearYou(free);

  // ─── Riders who fit a shared trip ───────────────────────────────────────
  const sharedTrip =
    trip?.type === "SHARED" && (trip.status === "MATCHED" || trip.status === "ARRIVED" || trip.status === "IN_PROGRESS")
      ? trip
      : null;
  const seated = sharedTrip
    ? overlayPassengers(sharedTrip.id, sharedTrip.passengers).filter(
        (p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP",
      ).length
    : 0;
  const freeSeats = Math.max(0, CAR_SEATS - seated);
  const fill = useQuery({
    queryKey: ["fillSuggestions", sharedTrip?.id],
    queryFn: () => getFillSuggestions(sharedTrip!.id),
    enabled: Boolean(sharedTrip) && freeSeats > 0,
    refetchInterval: 10_000,
  });
  const { refetch: refetchFill } = fill;
  useEffect(() => {
    if (!sharedTrip) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetchFill();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [sharedTrip, refetchFill]);

  const sharedFare = getSharedFarePerRider(1);
  const items: HomeRequest[] = useMemo(() => {
    if (free) {
      const open = (eligible.data ?? []).filter((r) => r.rideId !== actions.claim?.rideId);
      return filterRequestsByType(sortRequestsNearestFirst(open, position, zones), filter);
    }
    if (sharedTrip && freeSeats > 0) {
      const fits = (fill.data?.suggestions ?? [])
        .filter((s) => s.compatible && !actions.adds[s.requestRideId])
        .map((s) => ({
          rideId: s.requestRideId,
          type: "SHARED" as const,
          seats: 1,
          farePesewas: sharedFare,
          pickupZoneId: s.pickupZoneId,
          pickupZoneName: s.pickupZoneName,
          dropoffZoneName: s.dropoffZoneName,
          createdAt: s.createdAt,
          riderFirstName: s.riderFirstName,
        }));
      return sortRequestsNearestFirst(fits, position, zones);
    }
    return [];
  }, [free, eligible.data, actions.claim, actions.adds, position, zones, filter, sharedTrip, freeSeats, fill.data, sharedFare]);

  if (authLoading || tripLoading || !user) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const firstName = user.name?.split(" ")[0] ?? "Driver";
  const refreshing = free ? eligible.isRefetching : fill.isRefetching;
  const refresh = () => void (free ? eligible.refetch() : fill.refetch());

  const accept = (item: HomeRequest) => {
    const request = eligible.data?.find((r) => r.rideId === item.rideId);
    if (!request) return;
    runClaim(request);
    markTripOpened(item.rideId);
    router.push(`/ride/${item.rideId}`);
  };
  const add = (item: HomeRequest) => {
    const suggestion = fill.data?.suggestions.find((s) => s.requestRideId === item.rideId);
    if (!sharedTrip || !suggestion) return;
    runAddRider(sharedTrip.id, suggestion, sharedFare, position);
  };

  const header = (
    <View style={styles.headerBlock}>
      <View style={styles.header}>
        <View style={styles.greeting}>
          <Text variant="bodySmall" color="muted">
            Welcome back
          </Text>
          <Text variant="h1" numberOfLines={1}>
            {firstName}
          </Text>
        </View>
        <View style={styles.onlineToggle}>
          <View style={[styles.statusDot, isOnline ? styles.dotOnline : styles.dotOffline]} />
          <Text variant="bodySmall" style={styles.onlineLabel}>
            {isOnline ? "Online" : "Offline"}
          </Text>
          {/* Flips on tap; the server is told in the background (lib/presence). */}
          <Switch
            value={isOnline}
            onValueChange={toggle}
            trackColor={{ false: colors.ink[100], true: colors.primary[200] }}
            thumbColor={isOnline ? colors.primary[500] : colors.ink[300]}
            accessibilityLabel="Online"
            accessibilityHint={isOnline ? "Go offline and stop receiving requests" : "Go online to receive requests"}
          />
        </View>
      </View>

      {waking ? (
        <Text variant="caption" color="muted" accessibilityLiveRegion="polite">
          Connecting to CampusRide… this can take a few seconds.
        </Text>
      ) : null}

      {free && !outsideServiceArea ? (
        <View style={styles.chips}>
          {FILTERS.map(({ value, label }) => {
            const active = value === filter;
            return (
              <Pressable
                key={value}
                onPress={() => setFilter(value)}
                style={[styles.chip, active && styles.chipActive]}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`Show ${label.toLowerCase()} requests`}
              >
                <Text variant="bodySmall" style={active ? styles.chipTextActive : styles.chipText}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {sharedTrip && freeSeats > 0 && items.length > 0 ? (
        <Text variant="label" color="muted">
          RIDERS ON YOUR ROUTE · {freeSeats} FREE SEAT{freeSeats === 1 ? "" : "S"}
        </Text>
      ) : null}
    </View>
  );

  let empty: ReactElement;
  if (!isOnline) {
    empty = (
      <EmptyState
        illustration={<Illustration name="carIdle" size={170} float accessibilityLabel="Parked car" />}
        title="Ready when you are"
        body="Go online above to start getting trips around campus."
      />
    );
  } else if (outsideServiceArea) {
    empty = (
      <EmptyState
        illustration={<Illustration name="searchEmpty" size={150} accessibilityLabel="Map" />}
        title="You're outside the CampusRide area"
        body="Requests reach drivers within 2 km of campus. Head back towards campus and they'll start coming in."
      />
    );
  } else if (trip && trip.type === "LONE") {
    empty = (
      <EmptyState
        illustration={<Illustration name="carIdle" size={130} accessibilityLabel="Car" />}
        title="You're on a Ride alone trip"
        body="A private trip takes one rider, so new requests show here once it ends."
      />
    );
  } else if (sharedTrip && freeSeats === 0) {
    empty = (
      <EmptyState
        illustration={<Illustration name="carFull" size={130} accessibilityLabel="Full car" />}
        title="Your car is full"
        body="Riders on your route will show here again when a seat frees up."
      />
    );
  } else if (trip && !sharedTrip) {
    empty = <View />;
  } else {
    empty = (
      <EmptyState
        illustration={<Illustration name="pinRadar" size={150} pulse accessibilityLabel="Map pin" />}
        title={sharedTrip ? "No riders on your route right now" : "Waiting for requests"}
        body={
          sharedTrip
            ? "Riders whose trip fits yours show up here as they request."
            : "Keep the app open. New requests show up here as they come in."
        }
      />
    );
  }

  return (
    // On a trip the banner above already covers the top safe area.
    <Screen noPadding edges={trip ? [] : ["top"]}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.rideId}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        renderItem={({ item }) =>
          free ? (
            <RequestCard item={item} onAccept={() => accept(item)} />
          ) : (
            <RequestCard
              item={item}
              onSeeRoute={() => sharedTrip && router.push(`/ride/${sharedTrip.id}?preview=${item.rideId}`)}
              onAdd={() => add(item)}
            />
          )
        }
        contentContainerStyle={styles.content}
        ItemSeparatorComponent={Separator}
        refreshControl={
          free || sharedTrip ? (
            <RefreshControl refreshing={Boolean(refreshing)} onRefresh={refresh} tintColor={colors.primary[500]} />
          ) : undefined
        }
      />
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

function EmptyState({ illustration, title, body }: { illustration: ReactElement; title: string; body: string }) {
  return (
    <View style={styles.empty}>
      {illustration}
      <Text variant="h3" style={styles.emptyTitle}>
        {title}
      </Text>
      <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
        {body}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // One side padding (16) and one gap between sections, everywhere on Home.
  content: { flexGrow: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.xl },
  headerBlock: { gap: spacing.md, marginBottom: spacing.lg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  greeting: { flexShrink: 1 },
  onlineToggle: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  onlineLabel: { fontWeight: typography.weight.semibold },
  statusDot: { width: 10, height: 10, borderRadius: radii.full },
  dotOnline: { backgroundColor: colors.primary[500] },
  dotOffline: { backgroundColor: colors.ink[300] },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    backgroundColor: colors.surfaceMuted,
    minHeight: 36,
    justifyContent: "center",
  },
  chipActive: { backgroundColor: colors.primary[500] },
  chipText: { color: colors.ink[600], fontWeight: typography.weight.semibold },
  chipTextActive: { color: colors.white, fontWeight: typography.weight.semibold },
  separator: { height: spacing.md },
  // Fills the space under the header so the illustration sits centred in it.
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, paddingVertical: spacing["2xl"] },
  emptyTitle: { textAlign: "center" },
  emptyBody: { textAlign: "center", maxWidth: 300 },
});
