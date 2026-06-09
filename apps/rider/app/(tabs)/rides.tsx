import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, View } from "react-native";
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
              <ListRow
                title={`${ride.pickupZone.name} → ${ride.dropoffZone.name}`}
                subtitle={formatDate(ride.createdAt)}
                leading={
                  <ListRow.Icon
                    name={ride.type === "SHARED" ? "people-outline" : "person-outline"}
                    color={colors.primary[600]}
                    background={colors.primary[50]}
                  />
                }
                trailing={
                  <View style={styles.trailing}>
                    {ride.fareTotal != null ? (
                      <Text variant="bodyMedium">{formatGhs(ride.fareTotal)}</Text>
                    ) : null}
                    <Badge label={status.label} variant={status.variant} />
                  </View>
                }
                showChevron={false}
                onPress={isActive ? () => router.push(`/ride/searching?rideId=${ride.id}`) : undefined}
              />
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
