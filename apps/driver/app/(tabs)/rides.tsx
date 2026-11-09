import { useState } from "react";
import { RefreshControl, StyleSheet, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { clockTime, periodEarnings, recentTripDays, weekEarnings, type EarningsTripDay } from "@rida/shared";
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
  radii,
  sizes,
  spacing,
  useAuth,
  useCountUp,
  type DriverRideHistoryItem,
} from "@rida/mobile-shared";
import { WeekBars } from "../../components/earnings/WeekBars";
import { useDriverBalance } from "../../lib/balance";
import { driverRideHistoryQueryKey, fetchRecentRideHistory } from "../../lib/earnings";

type Period = "today" | "week" | "all";
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "all", label: "All time" },
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

function tripCount(n: number): string {
  return `${n} trip${n === 1 ? "" : "s"}`;
}

/**
 * Earnings — what the driver made after commission today, this week (a bar
 * a day, Monday to Sunday) or all time, how that splits, the balance owed to
 * CampusRide (tap: Balance), and the last 7 days of trips, a day per row
 * (today open, earlier days folded). From GET /driver/rides/history: the
 * trips of the last 7 days plus an all-time summary, all by the same rule
 * (earningsTotals, @rida/shared): Gross = the fares, Commission = 15% of
 * them, After commission = the sum of "You earn". Older trips stay on file
 * (and on the admin site); the app just doesn't list them.
 */
export default function EarningsTab() {
  const { isAuthenticated } = useAuth();
  const [period, setPeriod] = useState<Period>("today");
  const router = useRouter();
  const balance = useDriverBalance();

  const { data, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: driverRideHistoryQueryKey,
    queryFn: fetchRecentRideHistory,
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

  if (rides.length === 0 && summary.totalRides === 0) {
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

  const totals =
    period === "all"
      ? {
          trips: summary.totalRides,
          grossPesewas: summary.totalGrossPesewas,
          commissionPesewas: summary.totalCommissionPesewas,
          netPesewas: summary.netPesewas,
        }
      : periodEarnings(rides, period);
  const days = weekEarnings(rides);
  const tripsLabel = `${tripCount(totals.trips)} ${period === "today" ? "today" : period === "week" ? "this week" : "all time"}`;
  const owed = balance.data ? formatCedis(Math.max(0, balance.data.balancePesewas)) : "—";

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
          {period === "all" ? "Earned after commission" : "After commission"}
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
        {period === "all" ? null : (
          <ListRow
            divider
            title="Commission (15%)"
            trailing={
              <Text variant="bodyStrong" color="danger" tabular>
                −{formatCedis(totals.commissionPesewas)}
              </Text>
            }
            showChevron={false}
          />
        )}
        <ListRow
          divider
          title="Balance owed to CampusRide"
          trailing={
            <View style={styles.inline}>
              <Text variant="bodyStrong" tabular>
                {owed}
              </Text>
              <Ionicons name="chevron-forward" size={sizes.iconSm} color={colors.ink3} />
            </View>
          }
          onPress={() => router.push("/balance")}
          accessibilityLabel={`Balance owed to CampusRide, ${owed}`}
          accessibilityHint="See what you owe and pay it"
        />
      </View>

      {period === "all" ? null : <RecentTrips rides={rides} />}
    </Screen>
  );
}

/** The last 7 days of trips, a day per row: today open, earlier days folded ("Yesterday · 5 trips · GH₵59.50"). */
function RecentTrips({ rides }: { rides: DriverRideHistoryItem[] }) {
  const tripDays = recentTripDays(rides);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(tripDays.filter((d) => d.isToday).map((d) => d.start)));
  const toggle = (start: number) =>
    setOpen((was) => {
      const next = new Set(was);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });

  return (
    <View style={styles.section}>
      <View>
        <Text variant="title3" accessibilityRole="header">
          Trips
        </Text>
        <Text variant="caption" color="secondary">
          Last 7 days
        </Text>
      </View>
      {tripDays.length === 0 ? (
        <Text variant="body" color="secondary">
          No trips in the last 7 days.
        </Text>
      ) : (
        <View>
          {tripDays.map((day, i) => (
            <TripDay key={day.start} day={day} divider={i > 0} open={open.has(day.start)} onToggle={() => toggle(day.start)} />
          ))}
        </View>
      )}
    </View>
  );
}

function TripDay({
  day,
  divider,
  open,
  onToggle,
}: {
  day: EarningsTripDay<DriverRideHistoryItem>;
  divider: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const summary = `${day.label} · ${tripCount(day.trips)} · ${formatCedis(day.netPesewas)}`;
  return (
    <View>
      <ListRow
        divider={divider}
        title={day.label}
        subtitle={tripCount(day.trips)}
        trailing={
          <View style={styles.inline}>
            <Text variant="bodyStrong" tabular>
              {formatCedis(day.netPesewas)}
            </Text>
            <Ionicons name={open ? "chevron-up" : "chevron-down"} size={sizes.iconSm} color={colors.ink3} />
          </View>
        }
        onPress={onToggle}
        accessibilityLabel={`${summary} after commission`}
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? "Hides this day's trips" : "Shows this day's trips"}
      />
      {open ? (
        <View style={styles.dayTrips}>
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
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[5], paddingBottom: spacing[10] },
  title: { marginTop: spacing[2] },
  section: { gap: spacing[3] },
  hero: { gap: spacing[1] },
  inline: { flexDirection: "row", alignItems: "center", gap: spacing[1] },
  dayTrips: { paddingLeft: spacing[3] },
  earn: { alignItems: "flex-end" },
  empty: { alignItems: "center", gap: spacing[3], paddingTop: spacing[8] },
  centered: { textAlign: "center" },
});
