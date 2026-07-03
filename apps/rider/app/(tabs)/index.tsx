import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  withDelay,
  withTiming,
  type EntryAnimationsValues,
} from "react-native-reanimated";
import { getSharedFarePerRider, priceLoneRide } from "@rida/shared";
import {
  AnimatedPressable,
  Avatar,
  Badge,
  Card,
  ListRow,
  Screen,
  ServiceIcon,
  Text,
  brand,
  colors,
  formatGhs,
  getMyRides,
  motion,
  onBrand,
  radii,
  spacing,
  useAuth,
  type RideSummary,
} from "@rida/mobile-shared";

/** Staggered entrance: translateY 12 → 0 + fade, once on mount (same idiom as welcome). */
function enterUp(delay: number) {
  return (_: EntryAnimationsValues) => {
    "worklet";
    return {
      initialValues: { opacity: 0, transform: [{ translateY: 12 }] },
      animations: {
        opacity: withDelay(delay, withTiming(1, { duration: motion.duration.base })),
        transform: [{ translateY: withDelay(delay, withTiming(0, { duration: motion.duration.base })) }],
      },
    };
  };
}

/** Time-of-day greeting — label + a small Ionicons glyph for visual warmth. */
function getGreeting(): { label: string; icon: keyof typeof Ionicons.glyphMap } {
  const hour = new Date().getHours();
  if (hour < 12) return { label: "Good morning", icon: "sunny-outline" };
  if (hour < 17) return { label: "Good afternoon", icon: "partly-sunny-outline" };
  return { label: "Good evening", icon: "moon-outline" };
}

/**
 * Solid-green THIS MONTH stats card. Aggregates the rider's own
 * current-calendar-month completed rides from the already-fetched history —
 * no extra API call. Per-ride spend is the rider's own leg: the flat shared
 * fare for SHARED rides (fareTotal on a shared ride is the whole car's
 * total), fareTotal for LONE.
 */
function MonthlyStatsCard({ rides }: { rides: RideSummary[] }) {
  const now = new Date();
  const sharedFare = getSharedFarePerRider(1);
  const loneFare = priceLoneRide().fare;

  const monthRides = rides.filter((ride) => {
    const created = new Date(ride.createdAt);
    return (
      ride.status === "COMPLETED" &&
      created.getFullYear() === now.getFullYear() &&
      created.getMonth() === now.getMonth()
    );
  });

  const sharedCount = monthRides.filter((r) => r.type === "SHARED").length;
  const spentPesewas = monthRides.reduce(
    (sum, r) => sum + (r.type === "SHARED" ? sharedFare : r.fareTotal ?? loneFare),
    0,
  );
  const savedPesewas = sharedCount * (loneFare - sharedFare);

  return (
    <View style={styles.statsCard}>
      <View style={styles.statsLeft}>
        <Text variant="caption" style={styles.statsCaption}>
          THIS MONTH
        </Text>
        {monthRides.length > 0 ? (
          <Text variant="title" style={styles.statsTitle}>
            {monthRides.length} {monthRides.length === 1 ? "ride" : "rides"} · {formatGhs(spentPesewas)}
          </Text>
        ) : (
          <>
            <Text variant="title" style={styles.statsTitle}>
              No rides yet this month
            </Text>
            <Text variant="bodySmall" style={styles.statsSub}>
              Your first ride is {formatGhs(sharedFare)}
            </Text>
          </>
        )}
      </View>
      {savedPesewas > 0 ? (
        <View style={styles.statsSavings}>
          <Text variant="headline" style={styles.statsSavingsAmount}>
            {formatGhs(savedPesewas)}
          </Text>
          <Text variant="caption" style={styles.statsSavingsLabel}>
            saved sharing
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** Home tab — Bolt-style service grid + "Where to?" search bar + recent destinations. */
export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: rides } = useQuery<RideSummary[]>({ queryKey: ["myRides"], queryFn: getMyRides });

  const greeting = getGreeting();
  const firstName = user?.name?.split(" ")[0] ?? "Rider";
  const recentRides = (rides ?? []).slice(0, 3);

  const showComingSoon = (service: string) =>
    Alert.alert(`${service} is coming soon`, "We're working on it — check back in a future update.");

  return (
    <Screen scroll>
      <Animated.View entering={enterUp(0)} style={styles.header}>
        <View>
          <View style={styles.greetingRow}>
            <Ionicons name={greeting.icon} size={16} color={colors.accent[500]} />
            <Text variant="bodySmall" color="muted">
              {greeting.label}
            </Text>
          </View>
          <Text variant="h1">{firstName}</Text>
        </View>
        <AnimatedPressable
          onPress={() => router.push("/account")}
          accessibilityRole="button"
          accessibilityLabel="Account"
        >
          <Avatar name={user?.name ?? "Rider"} size={44} />
        </AnimatedPressable>
      </Animated.View>

      <Animated.View entering={enterUp(60)}>
        <MonthlyStatsCard rides={rides ?? []} />
      </Animated.View>

      <Animated.View entering={enterUp(120)} style={styles.grid}>
        <View style={styles.gridRow}>
          <AnimatedPressable style={styles.gridCell} onPress={() => router.push("/ride/location")}>
            <Card dark noPadding style={styles.tile}>
              <ServiceIcon name="car-sport" color={colors.white} background={onBrand.faint} size={48} />
              <Text variant="h3" color="inverse" style={styles.tileTitle}>
                Rides
              </Text>
              <Text variant="bodySmall" style={styles.tileSubtitleDark} numberOfLines={2}>
                Around campus, in minutes
              </Text>
              <Badge label="Live" variant="success" style={styles.tileBadge} />
            </Card>
          </AnimatedPressable>

          <AnimatedPressable style={styles.gridCell} onPress={() => showComingSoon("Food delivery")}>
            <Card noPadding style={styles.tile}>
              <ServiceIcon name="fast-food-outline" color={colors.accent[600]} background={colors.accent[50]} size={48} />
              <Text variant="h3" style={styles.tileTitle}>
                Food
              </Text>
              <Text variant="bodySmall" color="muted" numberOfLines={2}>
                Order from campus vendors
              </Text>
              <Badge label="Soon" variant="soon" style={styles.tileBadge} />
            </Card>
          </AnimatedPressable>
        </View>

        <AnimatedPressable onPress={() => showComingSoon("Courier")}>
          <Card noPadding style={styles.fullTile}>
            <ServiceIcon name="cube-outline" color={colors.accent[600]} background={colors.accent[50]} size={48} />
            <View style={styles.fullTileBody}>
              <Text variant="h3">Courier</Text>
              <Text variant="bodySmall" color="muted">
                Send packages around campus
              </Text>
            </View>
            <Badge label="Soon" variant="soon" />
          </Card>
        </AnimatedPressable>
      </Animated.View>

      <Animated.View entering={enterUp(180)}>
        <AnimatedPressable
          onPress={() => router.push("/ride/location")}
          style={styles.searchBar}
          accessibilityRole="button"
          accessibilityLabel="Where to?"
        >
          <Ionicons name="search" size={20} color={colors.ink[400]} />
          <Text variant="bodyMedium" color="muted" style={styles.searchLabel}>
            Where to?
          </Text>
        </AnimatedPressable>
      </Animated.View>

      <Animated.View entering={enterUp(240)}>
        <Text variant="label" color="muted" style={styles.sectionLabel}>
          RECENT DESTINATIONS
        </Text>

        {recentRides.length > 0 ? (
          <Card>
            {recentRides.map((ride, index) => (
              <View key={ride.id}>
                <ListRow
                  title={ride.dropoffZone.name}
                  subtitle={ride.dropoffZone.quadrant}
                  leading={<ListRow.Icon name="time-outline" color={colors.ink[500]} background={colors.surfaceMuted} />}
                  showChevron={false}
                  onPress={() => router.push("/ride/location")}
                />
                {index < recentRides.length - 1 ? <View style={styles.divider} /> : null}
              </View>
            ))}
          </Card>
        ) : (
          <Card style={styles.emptyRecents}>
            <Text variant="bodySmall" color="muted">
              Your recent trips will show here once you take your first ride.
            </Text>
          </Card>
        )}
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.xl,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: 2,
  },
  // ── THIS MONTH stats card
  statsCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: brand.primary,
    borderRadius: radii.lg,
    padding: spacing.gutter,
    marginBottom: spacing.lg,
  },
  statsLeft: {
    flex: 1,
    gap: spacing.xs,
  },
  statsCaption: {
    color: onBrand.secondary,
    letterSpacing: 1,
  },
  statsTitle: {
    color: colors.white,
  },
  statsSub: {
    color: onBrand.secondary,
  },
  statsSavings: {
    backgroundColor: onBrand.faint,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: "center",
    gap: 2,
  },
  statsSavingsAmount: {
    color: colors.white,
  },
  statsSavingsLabel: {
    color: onBrand.secondary,
  },
  // ── Service grid
  grid: {
    marginBottom: spacing.lg,
  },
  gridRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  gridCell: {
    flex: 1,
  },
  tile: {
    flex: 1,
    padding: spacing.lg,
    minHeight: 150,
    gap: spacing.xs,
    justifyContent: "space-between",
  },
  tileTitle: {
    marginTop: spacing.sm,
  },
  tileSubtitleDark: {
    color: onBrand.secondary,
  },
  tileBadge: {
    marginTop: spacing.xs,
  },
  fullTile: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.lg,
  },
  fullTileBody: {
    flex: 1,
    gap: 2,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.gutter,
    minHeight: 52,
    marginBottom: spacing["2xl"],
  },
  searchLabel: {
    flex: 1,
  },
  sectionLabel: {
    marginBottom: spacing.md,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  emptyRecents: {
    alignItems: "center",
  },
});
