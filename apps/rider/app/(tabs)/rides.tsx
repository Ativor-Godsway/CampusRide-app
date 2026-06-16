import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { RideStatus } from "@rida/shared";
import {
  Badge,
  type BadgeVariant,
  Card,
  EmptyState,
  LoadingState,
  ListRow,
  Screen,
  Text,
  colors,
  formatGhs,
  getMyRides,
  spacing,
  type RideSummary,
} from "@rida/mobile-shared";

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
  const { data, isLoading, isError } = useQuery<RideSummary[]>({
    queryKey: ["myRides"],
    queryFn: getMyRides,
  });

  if (isLoading) {
    return (
      <Screen>
        <LoadingState message="Loading your rides..." />
      </Screen>
    );
  }

  if (isError) {
    return (
      <Screen>
        <EmptyState
          title="Couldn't load your rides"
          message="Pull down to try again."
          icon={<Ionicons name="cloud-offline-outline" size={48} color={colors.ink[300]} />}
        />
      </Screen>
    );
  }

  if (!data || data.length === 0) {
    return (
      <Screen>
        <View style={styles.header}>
          <Text variant="h1">Your rides</Text>
        </View>
        <EmptyState
          title="No rides yet"
          message="Your trip history will show up here once you take your first ride."
          icon={<Ionicons name="car-outline" size={48} color={colors.ink[300]} />}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="h1">Your rides</Text>
      </View>

      <Card>
        {data.map((ride, index) => {
          const status = STATUS_BADGE[ride.status];
          const isActive = ACTIVE_STATUSES.includes(ride.status);
          return (
            <View key={ride.id}>
              <Pressable
                style={({ pressed }) => [styles.row, pressed && isActive && styles.pressed]}
                onPress={
                  isActive
                    ? () =>
                        router.push({
                          pathname: "/ride/type",
                          params: {
                            rideId: ride.id,
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
                accessibilityRole={isActive ? "button" : undefined}
              >
                <ListRow.Icon
                  name={ride.type === "SHARED" ? "people-outline" : "person-outline"}
                  color={colors.primary[600]}
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
                    <Text variant="bodyMedium">{formatGhs(ride.fareTotal)}</Text>
                  ) : null}
                  <Badge label={status.label} variant={status.variant} />
                </View>
              </Pressable>
              {index < data.length - 1 ? <View style={styles.divider} /> : null}
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
