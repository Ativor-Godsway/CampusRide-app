import { StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Ionicons } from "@expo/vector-icons";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  LoadingState,
  RouteStops,
  Screen,
  Text,
  colors,
  formatGhs,
  getDriverRideHistory,
  spacing,
  typography,
  useAuth,
} from "@rida/mobile-shared";
import type { DriverRideHistoryItem } from "@rida/mobile-shared";

/** Short, human date for a completed ride — system locale, no extra deps. */
function formatRideDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function HistoryRow({ item }: { item: DriverRideHistoryItem }) {
  return (
    <Card style={styles.rideCard}>
      <View style={styles.rideTop}>
        <View style={styles.tags}>
          <Badge variant="default" label={item.type === "SHARED" ? "Shared" : "Private"} />
          <Badge variant={item.source === "USSD" ? "warning" : "soon"} label={item.source} />
        </View>
        <Text variant="bodyMedium" style={styles.earn}>
          {formatGhs(item.driverGrossPesewas)}
        </Text>
      </View>

      <RouteStops
        connectorHeight={16}
        origin={<Text variant="bodySmall">{item.pickupZoneName}</Text>}
        destination={<Text variant="bodySmall">{item.dropoffZoneName}</Text>}
      />

      <Text variant="caption" color="muted">
        {formatRideDate(item.completedAt)}
      </Text>
    </Card>
  );
}

/**
 * Rides tab — real completed-ride history with derived (gross, unsettled)
 * earnings from GET /driver/rides/history. The earnings figure is what the
 * driver has accrued, not money that has been paid out (see the caption).
 */
export default function RidesTab() {
  const { isAuthenticated } = useAuth();

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["driverRideHistory"],
    queryFn: getDriverRideHistory,
    enabled: isAuthenticated,
  });

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (isError || !data) {
    return (
      <Screen>
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.ink[300]} />
          <Text variant="h3" style={styles.centerTitle}>
            Couldn&apos;t load your rides
          </Text>
          <Text variant="bodySmall" color="muted" style={styles.centerBody}>
            Check your connection and try again.
          </Text>
          <Button label="Retry" onPress={() => void refetch()} loading={isRefetching} />
        </View>
      </Screen>
    );
  }

  const { rides, summary } = data;

  return (
    <Screen scroll>
      <View style={styles.header}>
        <Text variant="h1">Your rides</Text>
      </View>

      {/*
        Phase 4: the headline figure is now NET, not gross. A driver taking
        cash fares keeps the whole fare in hand but owes 15% of each one back
        as commission, so showing only gross overstated what is actually
        theirs. Gross and commission stay visible underneath so the number is
        explainable rather than just smaller.
      */}
      <Card style={styles.earningsCard}>
        <Text variant="label" color="muted">
          YOUR EARNINGS
        </Text>
        <Text variant="h1" style={styles.earningsAmount}>
          {formatGhs(summary.netPesewas)}
        </Text>
        <Text variant="caption" color="muted">
          After commission · not yet settled
        </Text>

        <View style={styles.breakdown}>
          <View style={styles.breakdownRow}>
            <Text variant="bodySmall" color="muted">
              Gross earned
            </Text>
            <Text variant="bodySmall">{formatGhs(summary.totalGrossPesewas)}</Text>
          </View>
          <View style={styles.breakdownRow}>
            <Text variant="bodySmall" color="muted">
              Commission owed
            </Text>
            <Text variant="bodySmall" color="error">
              −{formatGhs(summary.commissionOwedPesewas)}
            </Text>
          </View>
        </View>

        {summary.commissionOwedPesewas > 0 && (
          <Text variant="caption" color="muted">
            Commission is 15% of each completed cash ride ({summary.commissionRidesCount}{" "}
            {summary.commissionRidesCount === 1 ? "ride" : "rides"}). We&apos;ll tell you how to
            settle it before any collection starts.
          </Text>
        )}

        <Text variant="bodySmall" color="muted" style={styles.ridesCount}>
          {summary.totalRides} {summary.totalRides === 1 ? "ride" : "rides"} completed
        </Text>
      </Card>

      {rides.length === 0 ? (
        <EmptyState
          title="No completed rides yet"
          message="Your trip history and earnings will show up here once you complete your first ride."
          icon={<Ionicons name="time-outline" size={48} color={colors.ink[300]} />}
        />
      ) : (
        <View style={styles.list}>
          {rides.map((item) => (
            <HistoryRow key={item.rideId} item={item} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  breakdown: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  breakdownRow: { flexDirection: "row", justifyContent: "space-between" },
  header: {
    marginBottom: spacing.xl,
  },
  earningsCard: {
    gap: spacing.xs,
    marginBottom: spacing.xl,
  },
  earningsAmount: {
    color: colors.primary[600],
  },
  ridesCount: {
    marginTop: spacing.xs,
  },
  list: {
    gap: spacing.md,
  },
  rideCard: {
    gap: spacing.sm,
  },
  rideTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  tags: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  earn: {
    color: colors.primary[600],
    fontWeight: typography.weight.semibold,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  centerTitle: {
    marginTop: spacing.sm,
  },
  centerBody: {
    textAlign: "center",
    marginBottom: spacing.sm,
  },
});
