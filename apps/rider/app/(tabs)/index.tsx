import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TripEnd } from "@rida/shared";
import {
  POPULAR_PLACE_NAMES,
  SERVICE_AREA_POLYGON,
  initialsOf,
  isSameSpot,
  placeEnd,
  recentTripEnds,
  tripEndParams,
  tripEndProblem,
} from "@rida/shared";
import {
  BottomSheet,
  Button,
  CampusMapView,
  Chip,
  ListRow,
  Notice,
  Skeleton,
  SkeletonGroup,
  StatusChip,
  Text,
  colors,
  getRecentRides,
  myRidesQueryKeys,
  radii,
  regionForCoordinates,
  shadows,
  spacing,
  useAuth,
  type ActiveRideSummary,
  type RideSummary,
} from "@rida/mobile-shared";
import { activeRideParams, useActiveRide } from "../../lib/activeRide";
import { useActiveRideStatus } from "../../lib/activeRideStatus";
import { chooseRideParams, usePlaces, useResolvePickup } from "../../lib/chooseRide";
import { useHomeLocation } from "../../lib/homeLocation";

/** "Good evening": by the phone's clock. */
function greetingFor(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** A stable key for a recent place or pin. */
function endKey(end: TripEnd): string {
  return end.placeId ?? `${end.latitude.toFixed(5)},${end.longitude.toFixed(5)}`;
}

/** The whole campus: the map's view when we don't know where the rider is. */
const CAMPUS_REGION = regionForCoordinates(
  SERVICE_AREA_POLYGON.map(([latitude, longitude]) => ({ latitude, longitude })),
  0.05,
);
/** Around the rider: a few streets. */
const NEARBY_DELTA = 0.008;
/** Before the sheet reports its height. */
const SHEET_ESTIMATE = 340;

/**
 * Home (docs/mockups/04-rider-home.png): the map first, the rider on it, and
 * a white sheet with "Where to?" — the one main action — and the places they
 * go. Recent places go straight to Choose a ride from where the rider is now.
 */
export default function HomeTab() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { user } = useAuth();
  const { location, turnOn } = useHomeLocation();
  const { data: activeRide } = useActiveRide();
  const resolvePickup = useResolvePickup();
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [areaHeight, setAreaHeight] = useState(windowHeight);
  const [sheetCover, setSheetCover] = useState(SHEET_ESTIMATE);
  const { data: places } = usePlaces();

  // Own cache key: the Rides tab caches history pages, a different shape.
  // Fetch a few more than we show so repeat trips still leave 3 distinct places.
  const { data: rides, isLoading: ridesLoading } = useQuery<RideSummary[]>({
    queryKey: myRidesQueryKeys.recent,
    queryFn: () => getRecentRides(10),
  });
  const recent = recentTripEnds(rides ?? [], places ?? null, 3);
  // A first-time rider (or recents that didn't load): three well-known places.
  const popular = useMemo(() => {
    const byName = new Map((places ?? []).map((p) => [p.name.toLowerCase(), p]));
    return POPULAR_PLACE_NAMES.map((n) => byName.get(n.toLowerCase()))
      .filter((p) => p !== undefined)
      .slice(0, 3)
      .map((p) => placeEnd(p));
  }, [places]);
  const suggestions = recent.length > 0 ? recent : popular;

  const firstName = user?.name?.split(" ")[0] ?? "";
  const initial = initialsOf(user?.name, 1) || "?";
  const region =
    location.state === "here"
      ? { ...location.coords, latitudeDelta: NEARBY_DELTA, longitudeDelta: NEARBY_DELTA }
      : CAMPUS_REGION;

  const planRide = () => router.push("/ride/location");
  const comingSoon = () =>
    Alert.alert(
      "Food and courier are coming soon",
      "We're working on it — check back in a future update.",
    );

  /**
   * A place goes STRAIGHT to Choose a ride, from where the rider is now. If we
   * can't tell where that is (location off), or they're already there, Plan
   * your ride opens with the destination filled in instead.
   */
  async function openPlace(destination: TripEnd) {
    if (openingKey) return;
    setOpeningKey(endKey(destination));
    try {
      const pickup = await resolvePickup();
      if (pickup && !tripEndProblem(pickup, "pickup") && !isSameSpot(pickup, destination)) {
        router.push({
          pathname: "/ride/type",
          params: chooseRideParams(pickup, destination, "home"),
        });
      } else {
        router.push({ pathname: "/ride/location", params: tripEndParams("dropoff", destination) });
      }
    } finally {
      setOpeningKey(null);
    }
  }

  return (
    <View style={styles.root} onLayout={(e) => setAreaHeight(e.nativeEvent.layout.height)}>
      <CampusMapView
        // A new view when we learn where the rider is (or that we can't).
        key={location.state === "here" ? "here" : "campus"}
        initialRegion={region}
        zones={[]}
        userLocation={location.state === "here" ? location.coords : null}
        height={areaHeight}
        light
        rounded={false}
        showRecenter
        recenterLabel={
          location.state === "here" ? "Recentre on your location" : "Show the whole campus"
        }
        controlsBottomInset={sheetCover}
      />

      <Pressable
        onPress={() => router.navigate("/account")}
        accessibilityRole="button"
        accessibilityLabel="Your account"
        style={({ pressed }) => [
          styles.account,
          { top: insets.top + spacing[2] },
          pressed && styles.accountPressed,
        ]}
      >
        <Text variant="title3" color="brand">
          {initial}
        </Text>
      </Pressable>

      <BottomSheet
        maxHeightRatio={0.75}
        contentStyle={styles.sheet}
        onChange={(_index, position) => {
          if (position > 0) setSheetCover(Math.round(areaHeight - position));
        }}
        accessibilityLabel="Where to?"
      >
        {activeRide ? (
          <ActiveRideRow ride={activeRide} />
        ) : (
          <Text variant="body" color="secondary">
            {greetingFor(new Date().getHours())}
            {firstName ? `, ${firstName}` : ""}
          </Text>
        )}

        <Pressable
          onPress={planRide}
          accessibilityRole="button"
          accessibilityLabel="Where to? Plan a ride"
          style={({ pressed }) => [styles.search, pressed && styles.searchPressed]}
        >
          <Ionicons name="search" size={24} color={colors.ink} />
          <Text variant="title2">Where to?</Text>
        </Pressable>

        {location.state === "off" ? (
          <View style={styles.notice}>
            <Notice
              tone="warning"
              icon="location-outline"
              message="Turn on location to set your pickup."
            />
            <Button label="Turn on location" variant="secondary" size="md" onPress={turnOn} />
          </View>
        ) : location.state === "outside" ? (
          <Notice
            tone="warning"
            icon="navigate-outline"
            message="You're outside campus. Pickups are on the University of Ghana (Legon) campus."
            style={styles.notice}
          />
        ) : null}

        {/* One row that scrolls sideways, edge to edge, starting on the gutter. */}
        {ridesLoading ? (
          <SkeletonGroup label="Loading your recent places" style={[styles.chipRow, styles.chips]}>
            <Skeleton width={128} height={36} radius={radii.full} />
            <Skeleton width={150} height={36} radius={radii.full} />
            <Skeleton width={112} height={36} radius={radii.full} />
          </SkeletonGroup>
        ) : suggestions.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipRow}
            contentContainerStyle={styles.chips}
            accessibilityLabel={recent.length > 0 ? "Recent places" : "Popular places"}
          >
            {suggestions.map((end) => (
              <Chip
                key={endKey(end)}
                kind="place"
                icon={recent.length > 0 ? "time-outline" : "location-outline"}
                label={end.label}
                disabled={openingKey !== null}
                onPress={() => void openPlace(end)}
                accessibilityLabel={`Ride to ${end.label}`}
              />
            ))}
          </ScrollView>
        ) : null}

        <View style={styles.divider} />

        <ListRow
          title="Food and courier"
          subtitle="Coming to campus soon"
          leading={<ListRow.Icon name="cube-outline" />}
          trailing={<StatusChip label="Soon" tone="warn" style={styles.soon} />}
          onPress={comingSoon}
        />
      </BottomSheet>
    </View>
  );
}

/** In place of the greeting while a ride is going on: "Your ride is on the way · Kwame, 3 min". */
function ActiveRideRow({ ride }: { ride: ActiveRideSummary }) {
  const router = useRouter();
  const { line, etaMinutes, destination } = useActiveRideStatus(ride);
  const onTheWay =
    ride.status === "MATCHED" && (ride.legStatus === null || ride.legStatus === "WAITING");
  const driver = ride.driver?.firstName;
  const subtitle = onTheWay
    ? [driver, etaMinutes !== null ? `${Math.max(1, Math.round(etaMinutes))} min` : null]
        .filter(Boolean)
        .join(", ") || `To ${destination}`
    : `To ${destination}`;
  return (
    <ListRow
      title={onTheWay ? "Your ride is on the way" : line}
      subtitle={subtitle}
      leading={<ListRow.Icon name="car-sport-outline" tone="brand" />}
      onPress={() => router.push({ pathname: "/ride/type", params: activeRideParams(ride) })}
      accessibilityLabel={`${line}. Ride to ${destination}. Open your ride.`}
    />
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.mapLand,
  },
  account: {
    position: "absolute",
    left: spacing.gutter,
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.float,
  },
  accountPressed: {
    backgroundColor: colors.surface2,
  },
  // Above the tab bar, which has its own safe-area padding.
  sheet: {
    gap: spacing[4],
    paddingBottom: spacing[5],
  },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    height: 60,
    paddingHorizontal: spacing[4],
    borderRadius: radii.lg,
    backgroundColor: colors.surface2,
  },
  searchPressed: {
    backgroundColor: colors.surface3,
  },
  notice: {
    gap: spacing[2],
  },
  // Bleeds past the sheet's padding so chips scroll to the screen edge.
  chipRow: {
    flexGrow: 0,
    marginHorizontal: -spacing.gutter,
    overflow: "hidden",
  },
  chips: {
    flexDirection: "row",
    gap: spacing[2],
    paddingHorizontal: spacing.gutter,
  },
  soon: {
    alignSelf: "center",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line,
  },
});
