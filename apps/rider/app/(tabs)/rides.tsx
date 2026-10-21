import { useRouter } from "expo-router";
import { clockTime, groupByDay, rideEnd, stopLabel, tripEndParams } from "@rida/shared";
import { useInfiniteQuery } from "@tanstack/react-query";
import { RefreshControl, StyleSheet, View } from "react-native";
import type { RideStatus } from "@rida/shared";
import {
  Button,
  Illustration,
  ListRow,
  Notice,
  Screen,
  SkeletonGroup,
  SkeletonListRows,
  StatusChip,
  Text,
  colors,
  formatCedis,
  getMyRidesPage,
  myRidesQueryKeys,
  spacing,
  type RideSummary,
} from "@rida/mobile-shared";
import { TAB_SCREEN_BOTTOM_PADDING } from "../../lib/layout";

const ACTIVE_STATUSES: RideStatus[] = [
  "REQUESTED",
  "MATCHED",
  "ARRIVED",
  "IN_PROGRESS",
  "AWAITING_RIDER_DECISION",
];

/**
 * A request absorbed into another car (#7: CANCELLED / MERGED) is still
 * going on — tapping it follows the pointer to the anchor ride.
 */
function isMerged(ride: RideSummary): boolean {
  return (
    ride.status === "CANCELLED" &&
    ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" &&
    !!ride.mergedIntoRideId
  );
}

/** Rides tab — the rider's trip history, grouped by day. */
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
  const days = groupByDay(rides, (ride) => ride.createdAt);

  const refreshControl = (
    <RefreshControl
      refreshing={isRefetching && !isFetchingNextPage}
      onRefresh={() => void refetch()}
      tintColor={colors.green500}
      colors={[colors.green500]}
    />
  );

  const title = (
    <Text variant="title1" accessibilityRole="header" style={styles.title}>
      Your rides
    </Text>
  );

  if (isLoading) {
    return (
      <Screen edges={["top"]} style={styles.content}>
        {title}
        <SkeletonGroup label="Loading your rides">
          <SkeletonListRows count={6} twoLines />
        </SkeletonGroup>
      </Screen>
    );
  }

  // First page failed: nothing to show, so say so where the list would be.
  if (isError && rides.length === 0) {
    return (
      <Screen edges={["top"]} style={styles.content}>
        {title}
        <View style={styles.error}>
          <Notice
            tone="error"
            icon="cloud-offline-outline"
            message="Couldn't load your rides. Check your connection and try again."
          />
          <Button
            label="Try again"
            variant="secondary"
            onPress={() => void refetch()}
            loading={isRefetching}
          />
        </View>
      </Screen>
    );
  }

  if (rides.length === 0) {
    return (
      <Screen scroll edges={["top"]} refreshControl={refreshControl} style={styles.content}>
        {title}
        <View style={styles.empty}>
          <Illustration name="carStandard" width={160} />
          <Text variant="title2" accessibilityRole="header" style={styles.centered}>
            No rides yet
          </Text>
          <Text variant="body" color="secondary" style={styles.centered}>
            Your trips will show up here after your first ride.
          </Text>
          <Button label="Book a ride" onPress={() => router.push("/ride/location")} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll edges={["top"]} refreshControl={refreshControl} style={styles.content}>
      {title}

      {days.map((day) => (
        <View key={day.label} style={styles.day}>
          <Text variant="bodyStrong" color="secondary" accessibilityRole="header">
            {day.label}
          </Text>
          <View>
            {day.items.map((ride, index) => {
              const resumable = ACTIVE_STATUSES.includes(ride.status) || isMerged(ride);
              const cancelled = ride.status === "CANCELLED" && !isMerged(ride);
              const from = stopLabel(ride.pickupLabel, ride.pickupZone.name);
              const to = stopLabel(ride.dropoffLabel, ride.dropoffZone.name);
              const kind = ride.type === "SHARED" ? "Shared" : "Ride alone";
              const price = ride.fareTotal != null ? formatCedis(ride.fareTotal) : null;
              return (
                <ListRow
                  key={ride.id}
                  divider={index > 0}
                  title={`${from} → ${to}`}
                  subtitle={`${clockTime(ride.createdAt)} · ${kind}`}
                  leading={<ListRow.Icon name="time-outline" />}
                  trailing={
                    cancelled ? (
                      <StatusChip label="Cancelled" tone="danger" style={styles.chip} />
                    ) : resumable ? (
                      <StatusChip label="In progress" tone="brand" style={styles.chip} />
                    ) : price ? (
                      <Text variant="bodyStrong" tabular>
                        {price}
                      </Text>
                    ) : null
                  }
                  showChevron={resumable}
                  accessibilityLabel={[
                    `${from} to ${to}`,
                    `${clockTime(ride.createdAt)}, ${kind}`,
                    cancelled ? "Cancelled" : resumable ? "In progress. Open your ride" : price,
                  ]
                    .filter(Boolean)
                    .join(". ")}
                  onPress={
                    resumable
                      ? () =>
                          router.push({
                            pathname: "/ride/type",
                            params: {
                              rideId: ride.mergedIntoRideId ?? ride.id,
                              ...tripEndParams("pickup", rideEnd(ride, "pickup", ride.pickupZone)),
                              ...tripEndParams(
                                "dropoff",
                                rideEnd(ride, "dropoff", ride.dropoffZone),
                              ),
                            },
                          })
                      : undefined
                  }
                />
              );
            })}
          </View>
        </View>
      ))}

      {hasNextPage && (
        <View style={styles.loadMore}>
          {isFetchNextPageError && !isFetchingNextPage ? (
            <Notice
              tone="error"
              message="Couldn't load older rides. Check your connection and try again."
            />
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
  content: { paddingBottom: TAB_SCREEN_BOTTOM_PADDING, gap: spacing[5] },
  title: { marginTop: spacing[2] },
  day: { gap: spacing[1] },
  chip: { alignSelf: "center" },
  error: { gap: spacing[3] },
  empty: { alignItems: "center", gap: spacing[3], paddingTop: spacing[8] },
  centered: { textAlign: "center" },
  loadMore: { gap: spacing[2] },
});
