import { useRouter } from "expo-router";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { RideStatus } from "@rida/shared";
import {
  Badge,
  type BadgeVariant,
  Card,
  EmptyState,
  ListRow,
  Screen,
  SkeletonGroup,
  SkeletonListRows,
  Text,
  colors,
  Button,
  formatCedis,
  getMyRidesPage,
  myRidesQueryKeys,
  spacing,
} from "@rida/mobile-shared";
import { TAB_SCREEN_BOTTOM_PADDING } from "../../lib/layout";

const STATUS_BADGE: Record<RideStatus, { label: string; variant: BadgeVariant }> = {
  REQUESTED: { label: "Requested", variant: "accent" },
  MATCHED: { label: "Matched", variant: "accent" },
  ARRIVED: { label: "Driver arrived", variant: "accent" },
  IN_PROGRESS: { label: "In progress", variant: "accent" },
  AWAITING_RIDER_DECISION: { label: "Awaiting decision", variant: "warning" },
  COMPLETED: { label: "Completed", variant: "success" },
  CANCELLED: { label: "Cancelled", variant: "error" },
};

const ACTIVE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "AWAITING_RIDER_DECISION",
];

function formatDate(value: Date | string): string {
  const date = new Date(value);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Rides tab — the rider's trip history. */
export default function RidesTab() {
  const router = useRouter();
  /**
   * Phase 4: paginated history. This used to fetch a single hard-capped page
   * of 50 with no way to reach anything older, so a regular rider simply lost
   * access to their earlier trips.
   *
   * Cursor-based (see GET /rides/mine): an offset would shift under the
   * rider if they booked a ride mid-scroll, duplicating or skipping a row.
   */
  const {
    data,
    isLoading,
    isError,
    refetch,
    isRefetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery({
    // Own key — Home's "recent" query caches a plain array, and sharing
    // ["myRides"] with it is what crashed this tab.
    queryKey: myRidesQueryKeys.history,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => getMyRidesPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage?.nextCursor ?? undefined,
  });

  const rides = data?.pages.flatMap((page) => page?.rides ?? []) ?? [];

  const refreshControl = (
    <RefreshControl
      refreshing={isRefetching && !isFetchingNextPage}
      onRefresh={() => void refetch()}
      tintColor={colors.primary[500]}
      colors={[colors.primary[500]]}
    />
  );

  if (isLoading) {
    return (
      <Screen edges={["top"]}>
        <View style={styles.header}>
          <Text variant="h1">Your rides</Text>
        </View>
        <Card>
          <SkeletonGroup label="Loading your rides">
            <SkeletonListRows count={5} twoLines />
          </SkeletonGroup>
        </Card>
      </Screen>
    );
  }

  // First page failed: nothing to show, so offer a retry instead.
  if (isError && rides.length === 0) {
    return (
      <Screen edges={["top"]}>
        <EmptyState
          title="Couldn't load your rides"
          message="Check your connection and try again."
          illustration="offline"
          action={<Button label="Retry" onPress={() => void refetch()} loading={isRefetching} />}
        />
      </Screen>
    );
  }

  if (rides.length === 0) {
    return (
      <Screen scroll edges={["top"]} refreshControl={refreshControl} style={styles.content}>
        <View style={styles.header}>
          <Text variant="h1">Your rides</Text>
        </View>
        <EmptyState
          title="No rides yet"
          message="Your trip history will show up here once you take your first ride."
          illustration="ridesEmpty"
        />
      </Screen>
    );
  }

  return (
    <Screen scroll edges={["top"]} refreshControl={refreshControl} style={styles.content}>
      <View style={styles.header}>
        <Text variant="h1">Your rides</Text>
      </View>

      <Card>
        {rides.map((ride, index) => {
          const status = STATUS_BADGE[ride.status];
          const isActive = ACTIVE_STATUSES.includes(ride.status);
          // #7: a request absorbed into another car (CANCELLED / MERGED) is
          // still resumable — tap follows the pointer to the anchor ride.
          const isMerged =
            ride.status === "CANCELLED" &&
            ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" &&
            !!ride.mergedIntoRideId;
          const isResumable = isActive || isMerged;
          return (
            <View key={ride.id}>
              <Pressable
                style={({ pressed }) => [styles.row, pressed && isResumable && styles.pressed]}
                onPress={
                  isResumable
                    ? () =>
                        router.push({
                          pathname: "/ride/type",
                          params: {
                            rideId: ride.mergedIntoRideId ?? ride.id,
                            pickupZoneId: ride.pickupZoneId,
                            dropoffZoneId: ride.dropoffZoneId,
                            pickupZoneName: ride.pickupZone.name,
                            dropoffZoneName: ride.dropoffZone.name,
                            pickupLat: String(ride.pickupZone.latitude),
                            pickupLng: String(ride.pickupZone.longitude),
                            dropoffLat: String(ride.dropoffZone.latitude),
                            dropoffLng: String(ride.dropoffZone.longitude),
                          },
                        })
                    : undefined
                }
                accessibilityRole={isResumable ? "button" : undefined}
              >
                <ListRow.Icon
                  name={ride.type === "SHARED" ? "people-outline" : "person-outline"}
                  color={colors.primary[500]}
                  background={colors.primary[50]}
                />
                <View style={styles.body}>
                  <View style={styles.routeRow}>
                    <View style={styles.markers}>
                      <View style={styles.dot} />
                      <View style={styles.connector} />
                      <Ionicons name="location" size={10} color={colors.ink[400]} />
                    </View>
                    <View style={styles.routeLabels}>
                      <Text variant="bodyMedium" numberOfLines={1}>
                        {ride.pickupZone.name}
                      </Text>
                      <Text variant="bodyMedium" numberOfLines={1}>
                        {ride.dropoffZone.name}
                      </Text>
                    </View>
                  </View>
                  <Text variant="bodySmall" color="muted" style={styles.date}>
                    {formatDate(ride.createdAt)}
                  </Text>
                </View>
                <View style={styles.trailing}>
                  {ride.fareTotal != null ? (
                    <Text variant="bodyMedium">{formatCedis(ride.fareTotal)}</Text>
                  ) : null}
                  <Badge label={status.label} variant={status.variant} />
                </View>
              </Pressable>
              {index < rides.length - 1 ? <View style={styles.divider} /> : null}
            </View>
          );
        })}
      </Card>

      {hasNextPage && (
        <View style={styles.loadMore}>
          {isFetchNextPageError && !isFetchingNextPage ? (
            <Text variant="bodySmall" color="error" style={styles.loadMoreError}>
              Couldn&apos;t load older rides. Check your connection and try again.
            </Text>
          ) : null}
          <Button
            label={isFetchNextPageError ? "Try again" : "Load older rides"}
            variant="secondary"
            onPress={() => void fetchNextPage()}
            loading={isFetchingNextPage}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: TAB_SCREEN_BOTTOM_PADDING },
  loadMore: { marginTop: spacing.lg, gap: spacing.sm },
  loadMoreError: { textAlign: "center" },
  header: {
    marginBottom: spacing.xl,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    gap: spacing.md,
  },
  pressed: {
    opacity: 0.6,
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  routeRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  markers: {
    alignItems: "center",
    width: 12,
    paddingTop: 4,
    paddingBottom: 2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary[500],
  },
  connector: {
    flex: 1,
    minHeight: 14,
    width: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  routeLabels: {
    flex: 1,
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  date: {
    marginLeft: 12 + spacing.sm,
  },
  trailing: {
    alignItems: "flex-end",
    gap: spacing.xs,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
});
