import { useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { clockTime, groupByDay, periodEarnings, weekEarnings } from "@rida/shared";
import {
  Button,
  Illustration,
  ListRow,
  Notice,
  Screen,
  SegmentedControl,
  SkeletonGroup,
  SkeletonListRows,
  Skeleton,
  Text,
  colors,
  formatCedis,
  getDriverRideHistory,
  radii,
  spacing,
  useAuth,
  useCountUp,
  type DriverRideHistoryItem,
} from "@rida/mobile-shared";
import { WeekBars } from "../../components/earnings/WeekBars";

type Period = "today" | "week";
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
] as const;

/** The big number counts up this fast (docs/design-system.md, "Motion"). */
const COUNT_MS = 600;

/** Counts up in whole cedis, then shows the exact amount; a negative amount just shows. */
function CountUpAmount({ pesewas }: { pesewas: number }) {
  const target = Math.max(0, Math.floor(pesewas / 100));
  const cedis = useCountUp(target, COUNT_MS);
  const shown = pesewas < 0 || cedis >= target ? pesewas : cedis * 100;
  return (
    <Text variant="display" tabular accessibilityLabel={formatCedis(pesewas)}>
      {formatCedis(shown)}
    </Text>
  );
}

/** "Maison Française → Night Market": place names, or zone names from an older server. */
function route(item: DriverRideHistoryItem): string {
  return `${item.pickupPlaceName ?? item.pickupZoneName} → ${item.dropoffPlaceName ?? item.dropoffZoneName}`;
}

/**
 * Earnings — what the driver made after commission today or this week (a
 * bar a day, Monday to Sunday), how that splits, and every completed trip by
 * day. All from GET /driver/rides/history: its own summary is all-time, so
 * the periods are added up here the same way (periodEarnings, @rida/shared).
 * Accrued, not paid out: commission isn't collected yet (see the note).
 */
export default function EarningsTab() {
  const { isAuthenticated } = useAuth();
  const [period, setPeriod] = useState<Period>("today");

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["driverRideHistory"],
    queryFn: getDriverRideHistory,
    enabled: isAuthenticated,
  });

  const title = (
    <Text variant="title1" accessibilityRole="header" style={styles.title}>
      Earnings
    </Text>
  );

  if (isLoading) {
    return (
      <Screen edges={["top"]} style={styles.content}>
        {title}
        <SkeletonGroup label="Loading your earnings" style={styles.section}>
          <Skeleton height={36} radius={radii.md} />
          <Skeleton width={180} height={44} />
          <SkeletonListRows count={5} twoLines />
        </SkeletonGroup>
      </Screen>
    );
  }

  if (isError || !data) {
    return (
      <Screen edges={["top"]} style={styles.content}>
        {title}
        <View style={styles.section}>
          <Notice
            tone="error"
            icon="cloud-offline-outline"
            message="Couldn't load your earnings. Check your connection and try again."
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

  const { rides, summary } = data;

  if (rides.length === 0) {
    return (
      <Screen edges={["top"]} style={styles.content}>
        {title}
        <View style={styles.empty}>
          <Illustration name="carStandard" width={160} />
          <Text variant="title2" style={styles.centered} accessibilityRole="header">
            No trips yet
          </Text>
          <Text variant="body" color="secondary" style={styles.centered}>
            Your earnings and completed trips show up here after your first trip.
          </Text>
        </View>
      </Screen>
    );
  }

  const totals = periodEarnings(rides, period);
  const days = weekEarnings(rides);
  const tripsLabel = `${totals.trips} trip${totals.trips === 1 ? "" : "s"} ${period === "today" ? "today" : "this week"}`;

  return (
    <Screen
      scroll
      edges={["top"]}
      style={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={() => void refetch()}
          tintColor={colors.green500}
          colors={[colors.green500]}
        />
      }
    >
      {title}

      <SegmentedControl
        options={PERIODS}
        value={period}
        onChange={setPeriod}
        accessibilityLabel="Earnings for"
      />

      <View style={styles.hero}>
        <Text variant="eyebrow" color="secondary">
          After commission
        </Text>
        <CountUpAmount key={period} pesewas={totals.netPesewas} />
        <Text variant="subhead" color="secondary">
          {tripsLabel}
        </Text>
      </View>

      {period === "week" ? <WeekBars days={days} /> : null}

      <View>
        <ListRow
          title="Gross"
          trailing={
            <Text variant="bodyStrong" tabular>
              {formatCedis(totals.grossPesewas)}
            </Text>
          }
          showChevron={false}
        />
        <ListRow
          divider
          title="Commission owed (15%)"
          trailing={
            <Text variant="bodyStrong" color="danger" tabular>
              −{formatCedis(totals.commissionPesewas)}
            </Text>
          }
          showChevron={false}
        />
        {summary.commissionOwedPesewas > 0 ? (
          <Text variant="caption" color="secondary" style={styles.note}>
            Commission is 15% of each completed cash trip (
            {formatCedis(summary.commissionOwedPesewas)} on {summary.commissionRidesCount}{" "}
            {summary.commissionRidesCount === 1 ? "trip" : "trips"} so far). We&apos;ll tell you how
            to settle it before any collection starts.
          </Text>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text variant="title3" accessibilityRole="header">
          Trips
        </Text>
        {groupByDay(rides, (r) => r.completedAt).map((day) => (
          <View key={day.label} style={styles.day}>
            <Text variant="bodyStrong" color="secondary" accessibilityRole="header">
              {day.label}
            </Text>
            <View>
              {day.items.map((item, i) => (
                <ListRow
                  key={item.rideId}
                  divider={i > 0}
                  title={route(item)}
                  subtitle={`${clockTime(item.completedAt)} · ${item.type === "SHARED" ? "Shared" : "Ride alone"}${item.source === "USSD" ? " · USSD" : ""}`}
                  trailing={
                    <View style={styles.earn}>
                      <Text variant="caption" color="secondary">
                        You earn
                      </Text>
                      <Text variant="bodyStrong" tabular>
                        {formatCedis(item.driverGrossPesewas)}
                      </Text>
                    </View>
                  }
                  showChevron={false}
                  accessibilityLabel={`${route(item)}, ${clockTime(item.completedAt)}. You earn ${formatCedis(item.driverGrossPesewas)}.`}
                />
              ))}
            </View>
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[5], paddingBottom: spacing[10] },
  title: { marginTop: spacing[2] },
  section: { gap: spacing[3] },
  hero: { gap: spacing[1] },
  note: { marginTop: spacing[2] },
  day: { gap: spacing[1] },
  earn: { alignItems: "flex-end" },
  empty: { alignItems: "center", gap: spacing[3], paddingTop: spacing[8] },
  centered: { textAlign: "center" },
});
