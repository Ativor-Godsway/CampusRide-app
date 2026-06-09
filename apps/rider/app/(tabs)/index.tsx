import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import {
  Badge,
  Card,
  ListRow,
  Screen,
  ServiceIcon,
  Text,
  colors,
  getMyRides,
  radii,
  spacing,
  useAuth,
  type RideSummary,
} from "@rida/mobile-shared";

/** Time-of-day greeting — label + a small Ionicons glyph for visual warmth. */
function getGreeting(): { label: string; icon: keyof typeof Ionicons.glyphMap } {
  const hour = new Date().getHours();
  if (hour < 12) return { label: "Good morning", icon: "sunny-outline" };
  if (hour < 17) return { label: "Good afternoon", icon: "partly-sunny-outline" };
  return { label: "Good evening", icon: "moon-outline" };
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
      <View style={styles.header}>
        <View>
          <View style={styles.greetingRow}>
            <Ionicons name={greeting.icon} size={16} color={colors.accent[500]} />
            <Text variant="bodySmall" color="muted">
              {greeting.label}
            </Text>
          </View>
          <Text variant="h1">{firstName}</Text>
        </View>
        <Pressable
          onPress={() => router.push("/account")}
          style={styles.avatar}
          accessibilityRole="button"
          accessibilityLabel="Account"
        >
          <Text variant="h3" color="inverse">
            {firstName.charAt(0).toUpperCase()}
          </Text>
        </Pressable>
      </View>

      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <Pressable style={styles.gridCell} onPress={() => router.push("/ride/location")}>
            <Card dark noPadding style={styles.tile}>
              <ServiceIcon
                name="car-sport"
                color={colors.white}
                background="rgba(255,255,255,0.14)"
                size={48}
              />
              <Text variant="h3" color="inverse" style={styles.tileTitle}>
                Rides
              </Text>
              <Text variant="bodySmall" style={styles.tileSubtitleDark} numberOfLines={2}>
                Around campus, in minutes
              </Text>
              <Badge label="Live" variant="success" style={styles.tileBadge} />
            </Card>
          </Pressable>

          <Pressable style={styles.gridCell} onPress={() => showComingSoon("Food delivery")}>
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
          </Pressable>
        </View>

        <Pressable onPress={() => showComingSoon("Courier")}>
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
        </Pressable>
      </View>

      <Pressable
        onPress={() => router.push("/ride/location")}
        style={styles.searchBar}
        accessibilityRole="button"
        accessibilityLabel="Where to?"
      >
        <Ionicons name="search" size={20} color={colors.ink[400]} />
        <Text variant="bodyMedium" color="muted" style={styles.searchLabel}>
          Where to?
        </Text>
      </Pressable>

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
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
    alignItems: "center",
    justifyContent: "center",
  },
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
    color: "rgba(255,255,255,0.7)",
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
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
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
