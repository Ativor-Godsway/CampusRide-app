import { useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Zone } from "@rida/shared";
import { recentDestinations } from "@rida/shared";
import {
  Badge,
  Card,
  Illustration,
  ListRow,
  PressableScale,
  Screen,
  ServiceIcon,
  SkeletonGroup,
  SkeletonListRows,
  Text,
  colors,
  getRecentRides,
  illustrations,
  myRidesQueryKeys,
  radii,
  shadows,
  spacing,
  typography,
  useAuth,
  type RideSummary,
} from "@rida/mobile-shared";
import { chooseRideParams, useResolvePickup } from "../../lib/chooseRide";
import { TAB_SCREEN_BOTTOM_PADDING } from "../../lib/layout";

/** Time-of-day greeting — label + a small Ionicons glyph for visual warmth. */
function getGreeting(): { label: string; icon: keyof typeof Ionicons.glyphMap } {
  const hour = new Date().getHours();
  if (hour < 12) return { label: "Good morning", icon: "sunny-outline" };
  if (hour < 17) return { label: "Good afternoon", icon: "partly-sunny-outline" };
  return { label: "Good evening", icon: "moon-outline" };
}

/**
 * Home: greeting → "Where to?" (the main action) → service tiles → Recent.
 * No avatar: the Account tab already is the way to your profile.
 */
export default function HomeTab() {
  const router = useRouter();
  const { user } = useAuth();
  const resolvePickup = useResolvePickup();
  const [openingZoneId, setOpeningZoneId] = useState<string | null>(null);

  // Own cache key: the Rides tab caches history pages, a different shape.
  // Fetch a few more than we show so repeat trips still leave 3 distinct places.
  const {
    data: rides,
    isLoading,
    isError,
    refetch,
  } = useQuery<RideSummary[]>({
    queryKey: myRidesQueryKeys.recent,
    queryFn: () => getRecentRides(10),
  });
  const recent = recentDestinations(rides ?? [], 3);

  const greeting = getGreeting();
  const firstName = user?.name?.split(" ")[0] ?? "Rider";

  const planRide = () => router.push("/ride/location");
  const showComingSoon = (service: string) =>
    Alert.alert(`${service} is coming soon`, "We're working on it — check back in a future update.");

  /**
   * A recent place goes STRAIGHT to Choose a ride, from where the rider is
   * now. If we can't tell where that is (location off), or they're already
   * there, Plan your ride opens with the destination filled in instead.
   */
  async function openRecent(destination: Zone) {
    if (openingZoneId) return;
    setOpeningZoneId(destination.id);
    try {
      const pickup = await resolvePickup();
      if (pickup && pickup.id !== destination.id) {
        router.push({ pathname: "/ride/type", params: chooseRideParams(pickup, destination, "home") });
      } else {
        router.push({ pathname: "/ride/location", params: { dropoffZoneId: destination.id } });
      }
    } finally {
      setOpeningZoneId(null);
    }
  }

  return (
    <Screen scroll edges={["top"]} style={styles.content}>
      <View style={styles.header}>
        <View style={styles.greetingRow}>
          <Ionicons name={greeting.icon} size={16} color={colors.accent[500]} />
          <Text variant="bodySmall" color="muted">
            {greeting.label}
          </Text>
        </View>
        <Text variant="h1" numberOfLines={1}>
          {firstName}
        </Text>
      </View>

      <PressableScale
        onPress={planRide}
        style={styles.searchBar}
        accessibilityRole="button"
        accessibilityLabel="Where to? Plan a ride"
      >
        <View style={styles.searchDot} />
        <Text variant="bodyMedium" style={styles.searchLabel}>
          Where to?
        </Text>
        <Ionicons name="search" size={20} color={colors.ink[400]} />
      </PressableScale>

      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <PressableScale
            style={styles.gridCell}
            onPress={planRide}
            accessibilityRole="button"
            accessibilityLabel="Rides around campus, live now"
          >
            {/* glow={false}: no decorative circle behind the car. */}
            <Card dark glow={false} noPadding style={[styles.tile, styles.ridesTile]}>
              {/* Clipped in its own layer: overflow:hidden on the card itself
                  would also clip the card's shadow on iOS. */}
              <View style={styles.carClip} pointerEvents="none">
                <Image
                  source={illustrations.serviceRide}
                  style={styles.ridesCar}
                  resizeMode="contain"
                  accessibilityIgnoresInvertColors
                />
              </View>
              <View style={styles.tileText}>
                <Text variant="h3" color="inverse" numberOfLines={1}>
                  Rides
                </Text>
                <Text variant="bodySmall" style={styles.tileSubtitleDark} numberOfLines={1}>
                  Around campus
                </Text>
                <Badge label="Live" variant="success" style={styles.tileBadge} />
              </View>
            </Card>
          </PressableScale>

          <Pressable style={styles.gridCell} onPress={() => showComingSoon("Food delivery")}>
            <Card noPadding style={styles.tile}>
              <ServiceIcon name="fast-food-outline" size={64} source={illustrations.serviceFood} />
              <Text variant="h3" style={styles.tileTitle}>
                Food
              </Text>
              <Text variant="bodySmall" color="muted" numberOfLines={2}>
                Order from campus vendors
              </Text>
              <Badge label="Soon" variant="soon" style={styles.tileBadge} />
            </Card>
          </Pressable>
        </View>

        <Pressable onPress={() => showComingSoon("Courier")}>
          <Card noPadding style={styles.fullTile}>
            <ServiceIcon name="cube-outline" size={64} source={illustrations.serviceCourier} />
            <View style={styles.fullTileBody}>
              <Text variant="h3">Courier</Text>
              <Text variant="bodySmall" color="muted">
                Send packages around campus
              </Text>
            </View>
            <Badge label="Soon" variant="soon" />
          </Card>
        </Pressable>
      </View>

      <Text variant="h3" style={styles.sectionTitle} accessibilityRole="header">
        Recent
      </Text>

      {isLoading ? (
        <Card>
          <SkeletonGroup label="Loading your recent places">
            <SkeletonListRows count={3} />
          </SkeletonGroup>
        </Card>
      ) : isError ? (
        <Card style={styles.emptyRecents}>
          <Text variant="bodySmall" color="muted" style={styles.centered}>
            Couldn&apos;t load your recent places.
          </Text>
          <Pressable onPress={() => void refetch()} accessibilityRole="button" hitSlop={8}>
            <Text variant="bodyMedium" color="primary">
              Try again
            </Text>
          </Pressable>
        </Card>
      ) : recent.length > 0 ? (
        <Card>
          {recent.map((zone, index) => (
            <View key={zone.id}>
              <ListRow
                title={zone.name}
                leading={<ListRow.Icon name="time-outline" color={colors.ink[500]} background={colors.surfaceMuted} />}
                trailing={
                  openingZoneId === zone.id ? <ActivityIndicator color={colors.primary[500]} /> : undefined
                }
                showChevron={openingZoneId !== zone.id}
                onPress={() => void openRecent(zone)}
                accessibilityLabel={`Ride to ${zone.name}`}
              />
              {index < recent.length - 1 ? <View style={styles.divider} /> : null}
            </View>
          ))}
        </Card>
      ) : (
        <Card style={styles.emptyRecents}>
          <Illustration name="ridesEmpty" size={110} />
          <Text variant="bodySmall" color="muted" style={styles.centered}>
            Your recent trips will show here once you take your first ride.
          </Text>
        </Card>
      )}
    </Screen>
  );
}

const TILE_HEIGHT = 168;

const styles = StyleSheet.create({
  content: {
    paddingBottom: TAB_SCREEN_BOTTOM_PADDING,
  },
  header: {
    marginBottom: spacing.lg,
  },
  greetingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginBottom: 2,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.lg,
    minHeight: 56,
    marginBottom: spacing.xl,
    ...shadows.md,
  },
  searchDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
  },
  searchLabel: {
    flex: 1,
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
  },
  grid: {
    marginBottom: spacing.xl,
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
    minHeight: TILE_HEIGHT,
    gap: spacing.xs,
    justifyContent: "space-between",
  },
  ridesTile: {
    justifyContent: "flex-end",
  },
  carClip: {
    ...StyleSheet.absoluteFill,
    borderRadius: radii.lg,
    overflow: "hidden",
  },
  ridesCar: {
    position: "absolute",
    top: spacing.xs,
    right: -36,
    width: 150,
    height: 104,
  },
  tileText: {
    gap: 2,
  },
  tileTitle: {
    marginTop: spacing.sm,
  },
  tileSubtitleDark: {
    color: colors.ink[200],
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
  sectionTitle: {
    marginBottom: spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.xs,
  },
  emptyRecents: {
    alignItems: "center",
    gap: spacing.sm,
  },
  centered: {
    textAlign: "center",
  },
});
