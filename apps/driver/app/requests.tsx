import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  filterRequestsByType,
  formatDistance,
  requestedAgo,
  sortRequestsNearestFirst,
  spokenCedis,
  type RequestTypeFilter,
  type WithDistance,
} from "@rida/shared";
import {
  Badge,
  Button,
  Card,
  Illustration,
  RouteStops,
  Screen,
  Text,
  colors,
  formatCedis,
  getZones,
  radii,
  shadows,
  spacing,
  typography,
  type EligibleRideItem,
} from "@rida/mobile-shared";
import { markTripOpened, useDriverActiveTrip } from "../lib/activeTrip";
import { runClaim } from "../lib/tripActions";
import { useDriverPresence } from "../lib/presence";
import { zonesQueryKey } from "../lib/zones";
import { useRequestsNearYou } from "../lib/requests";

type NearbyRequest = WithDistance<EligibleRideItem>;

const FILTERS: { value: RequestTypeFilter; label: string }[] = [
  { value: "ALL", label: "All" },
  { value: "SHARED", label: "Shared" },
  { value: "LONE", label: "Private" },
];

function typeLabel(item: EligibleRideItem): string {
  if (item.type === "LONE") return "Private";
  const seats = item.seats ?? 1;
  return `Shared · ${seats}`;
}

function spokenSummary(item: NearbyRequest): string {
  const kind =
    item.type === "LONE"
      ? "Private ride"
      : `Shared ride, ${item.seats ?? 1} ${(item.seats ?? 1) === 1 ? "rider" : "riders"}`;
  const distance = item.distanceMeters !== null ? `, ${formatDistance(item.distanceMeters)} away` : "";
  return `${kind}${distance}, ${spokenCedis(item.farePesewas)}. From ${item.pickupZoneName} to ${item.dropoffZoneName}. ${requestedAgo(item.createdAt)}.`;
}

function RequestRow({
  item,
  claiming,
  disabled,
  onAccept,
}: {
  item: NearbyRequest;
  claiming: boolean;
  disabled: boolean;
  onAccept: () => void;
}) {
  return (
    <Card style={styles.card}>
      <View accessible accessibilityLabel={spokenSummary(item)} style={styles.cardBody}>
        <View style={styles.cardTop}>
          <Badge label={typeLabel(item)} variant={item.type === "SHARED" ? "success" : "default"} />
          {item.distanceMeters !== null && (
            <Text variant="caption" color="muted">{formatDistance(item.distanceMeters)}</Text>
          )}
          <Text variant="h3" style={styles.price}>{formatCedis(item.farePesewas)}</Text>
        </View>
        <RouteStops
          connectorHeight={14}
          origin={<Text variant="bodyMedium" style={styles.place}>{item.pickupZoneName}</Text>}
          destination={<Text variant="bodyMedium" style={styles.place}>{item.dropoffZoneName}</Text>}
        />
      </View>
      <View style={styles.cardBottom}>
        <Text variant="caption" color="muted" style={styles.ago}>{requestedAgo(item.createdAt)}</Text>
        <Button
          label="Accept"
          fullWidth={false}
          onPress={onAccept}
          loading={claiming}
          disabled={disabled}
          accessibilityLabel={`Accept ride from ${item.pickupZoneName} to ${item.dropoffZoneName}`}
        />
      </View>
    </Card>
  );
}

/**
 * "Requests near you": every request this driver may claim, nearest pickup
 * first, filtered by type. Accept is the same atomic claim as always; losing
 * the race is a normal outcome ("taken by another driver"), not an error.
 */
export default function RequestsNearYouScreen() {
  const router = useRouter();
  const { isOnline, position, toggle } = useDriverPresence();
  const { data: activeTrip } = useDriverActiveTrip();
  const [filter, setFilter] = useState<RequestTypeFilter>("ALL");

  const { data: zones = [] } = useQuery({ queryKey: zonesQueryKey, queryFn: getZones, staleTime: Infinity });
  const {
    data: requests = [],
    refetch,
    isRefetching,
  } = useRequestsNearYou(isOnline && !activeTrip);

  const sorted = useMemo(
    () => sortRequestsNearestFirst(requests, position, zones),
    [requests, position, zones],
  );
  const visible = filterRequestsByType(sorted, filter);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  // Accept is instant: the trip opens now and the claim follows in the
  // background (lib/tripActions — retried quietly if CampusRide is slow).
  // If another driver got there first, the trip screen says so.
  const accept = useCallback(
    (item: NearbyRequest) => {
      runClaim(item);
      markTripOpened(item.rideId);
      router.replace(`/ride/${item.rideId}`);
    },
    [router],
  );

  const header = (
    <>
      <View style={styles.header}>
        <Pressable
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={styles.back}
        >
          <Ionicons name="arrow-back" size={22} color={colors.ink[900]} />
        </Pressable>
        <Text variant="h2" accessibilityRole="header">Requests near you</Text>
      </View>
      {isOnline && !activeTrip && (
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
      )}
    </>
  );

  let empty: ReactElement;
  if (!isOnline) {
    empty = (
      <View style={styles.empty}>
        <Illustration name="carIdle" size={150} float accessibilityLabel="Parked car" />
        <Text variant="h3">You&apos;re offline</Text>
        <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
          Go online to see requests near you.
        </Text>
        <Button label="Go online" onPress={toggle} />
      </View>
    );
  } else if (activeTrip) {
    empty = (
      <View style={styles.empty}>
        <Illustration name="carIdle" size={150} float accessibilityLabel="Car" />
        <Text variant="h3">You&apos;re on a trip</Text>
        <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
          Finish your trip to pick up a new request.
        </Text>
      </View>
    );
  } else {
    empty = (
      <View style={styles.empty}>
        <Illustration name="searchEmpty" size={130} float accessibilityLabel="No requests" />
        <Text variant="h3">{requests.length === 0 ? "No requests right now" : "None of this type"}</Text>
        <Text variant="bodySmall" color="muted" style={styles.emptyBody}>
          {requests.length === 0
            ? "New requests near you appear here as soon as riders ask."
            : "Tap “All” to see every request near you."}
        </Text>
      </View>
    );
  }

  return (
    <Screen noKeyboardHandling>
      <FlatList
        data={isOnline && !activeTrip ? visible : []}
        keyExtractor={(item) => item.rideId}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.primary[500]}
          />
        }
        renderItem={({ item }) => (
          <RequestRow
            item={item}
            claiming={false}
            disabled={false}
            onAccept={() => void accept(item)}
          />
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { paddingBottom: spacing.xl, gap: spacing.sm },
  header: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginBottom: spacing.md },
  back: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.sm,
  },
  chips: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  chipActive: { borderColor: colors.primary[500], backgroundColor: colors.primary[50] },
  chipText: { color: colors.ink[600], fontWeight: typography.weight.semibold },
  chipTextActive: { color: colors.primary[500], fontWeight: typography.weight.semibold },
  card: { gap: spacing.sm },
  cardBody: { gap: spacing.sm },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  price: { marginLeft: "auto", fontWeight: typography.weight.extrabold },
  place: { fontWeight: typography.weight.semibold },
  cardBottom: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  ago: { flex: 1 },
  empty: { alignItems: "center", gap: spacing.md, paddingVertical: spacing["3xl"] },
  emptyBody: { textAlign: "center", maxWidth: 260 },
});
