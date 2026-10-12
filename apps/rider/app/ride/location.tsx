import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { CampusPlace, PlaceCategory, TripEnd } from "@rida/shared";
import {
  CURRENT_LOCATION_LABEL,
  PLACES_ATTRIBUTION,
  POPULAR_PLACE_NAMES,
  gpsSubtitle,
  isSameSpot,
  placeEnd,
  recentTripEnds,
  searchPlaces,
  tripEndFromParams,
  tripEndParams,
  tripEndProblem,
} from "@rida/shared";
import {
  Button,
  Card,
  ListRow,
  Screen,
  SkeletonGroup,
  SkeletonListRows,
  Text,
  colors,
  getRecentRides,
  myRidesQueryKeys,
  radii,
  shadows,
  spacing,
  typography,
  type RideSummary,
} from "@rida/mobile-shared";
import { chooseRideParams, usePlaces, useResolvePickup } from "../../lib/chooseRide";
import { setPickedPin, usePickedPin } from "../../lib/planDraft";

type Field = "pickup" | "dropoff";
type IconName = ComponentProps<typeof Ionicons>["name"];

const CATEGORY_ICON: Record<PlaceCategory, IconName> = {
  HALL: "bed-outline",
  HOSTEL: "home-outline",
  FACULTY: "school-outline",
  GATE: "enter-outline",
  FOOD: "restaurant-outline",
  LANDMARK: "location-outline",
  OTHER: "location-outline",
};

/**
 * Plan your ride: exact pickup and drop-off.
 *
 * - Pickup starts as the rider's live position ("Current location", with
 *   the place they're at when it's within ~50 m).
 * - Typing searches the campus places by name and alias, typos and all.
 *   With nothing typed: Recent, then Popular on campus.
 * - "Choose on map" drops a pin anywhere inside the CampusRide area.
 * - An end outside the area is refused here, with the reason, and the ride
 *   can't continue until it is changed.
 *
 * Once both ends are set and valid it goes straight to Choose a ride.
 * Optional params pre-fill the fields (tripEndParams for "pickup" / "dropoff").
 */
export default function PlanRideScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Record<string, string>>();
  const resolvePickup = useResolvePickup();

  const { data: places, isLoading: placesLoading, isError: placesError, refetch: refetchPlaces } = usePlaces();
  const { data: rides, isLoading: ridesLoading } = useQuery<RideSummary[]>({
    queryKey: myRidesQueryKeys.recent,
    queryFn: () => getRecentRides(10),
  });

  const [pickup, setPickup] = useState<TripEnd | null>(() => tripEndFromParams("pickup", params));
  const [dropoff, setDropoff] = useState<TripEnd | null>(() => tripEndFromParams("dropoff", params));
  const [pickupText, setPickupText] = useState(pickup?.label ?? "");
  const [dropoffText, setDropoffText] = useState(dropoff?.label ?? "");
  const [active, setActive] = useState<Field>(dropoff && !pickup ? "pickup" : "dropoff");
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pickupInput = useRef<TextInput>(null);
  const dropoffInput = useRef<TextInput>(null);

  // Pickup = where the rider is now, unless one was given.
  const located = useRef(false);
  useEffect(() => {
    if (located.current || pickup) return;
    located.current = true;
    setLocating(true);
    void resolvePickup()
      .then((here) => {
        if (!here) return;
        // Only fill if the rider hasn't picked their own pickup meanwhile.
        setPickup((current) => current ?? here);
        setPickupText((current) => current || here.label);
        const why = tripEndProblem(here, "pickup");
        if (why) setProblem(why);
      })
      .finally(() => setLocating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recent = useMemo(() => recentTripEnds(rides ?? [], places ?? null, 3), [rides, places]);
  const popular = useMemo(() => {
    const byName = new Map((places ?? []).map((p) => [p.name.toLowerCase(), p]));
    return POPULAR_PLACE_NAMES.map((n) => byName.get(n.toLowerCase())).filter((p): p is CampusPlace => !!p);
  }, [places]);

  // A field showing its chosen end's own label isn't a search.
  const activeText = active === "pickup" ? pickupText : dropoffText;
  const activeEnd = active === "pickup" ? pickup : dropoff;
  const otherEnd = active === "pickup" ? dropoff : pickup;
  const query = activeEnd && activeText === activeEnd.label ? "" : activeText.trim();
  const results = useMemo(
    () => (query ? searchPlaces(places ?? [], query, 8).filter((p) => !isSameSpot(placeEnd(p), otherEnd)) : []),
    [places, query, otherEnd],
  );

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  function focus(field: Field) {
    setActive(field);
    (field === "pickup" ? pickupInput : dropoffInput).current?.focus();
  }

  /** Move on when both ends are set and fine; otherwise say what's wrong, or ask for the missing end. */
  function proceed(nextPickup: TripEnd | null, nextDropoff: TripEnd | null, justSet: Field) {
    const why =
      (nextPickup && tripEndProblem(nextPickup, "pickup")) || (nextDropoff && tripEndProblem(nextDropoff, "dropoff"));
    if (why) {
      setProblem(why);
      return;
    }
    if (nextPickup && nextDropoff) {
      if (isSameSpot(nextPickup, nextDropoff)) {
        setProblem("Your pickup and drop-off are the same place. Choose a different drop-off.");
        return;
      }
      setProblem(null);
      router.push({ pathname: "/ride/type", params: chooseRideParams(nextPickup, nextDropoff, "plan") });
      return;
    }
    setProblem(null);
    focus(justSet === "pickup" ? "dropoff" : "pickup");
  }

  function choose(end: TripEnd, field: Field = active) {
    if (field === "pickup") {
      setPickup(end);
      setPickupText(end.label);
    } else {
      setDropoff(end);
      setDropoffText(end.label);
    }
    proceed(field === "pickup" ? end : pickup, field === "dropoff" ? end : dropoff, field);
  }

  async function pickCurrentLocation() {
    setLocating(true);
    try {
      const here = await resolvePickup();
      if (here) choose(here, "pickup");
      else setProblem("We couldn't find where you are. Turn on location, or search for your pickup.");
    } finally {
      setLocating(false);
    }
  }

  // "Choose on map" hands its pin back through planDraft.
  const picked = usePickedPin();
  useEffect(() => {
    if (!picked) return;
    setPickedPin(null);
    choose(picked.end, picked.field);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked]);

  function chooseOnMap() {
    const start = activeEnd ?? otherEnd;
    router.push({
      pathname: "/ride/pick",
      params: { field: active, ...(start ? tripEndParams("pickup", start) : {}) },
    });
  }

  const listsLoading = placesLoading || ridesLoading;
  const pickupSubtitle = pickup ? gpsSubtitle(pickup, places ?? []) : null;
  const bothSet = Boolean(pickup && dropoff);

  return (
    <Screen scroll>
      <Pressable onPress={goBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.back}>
        <Ionicons name="arrow-back" size={24} color={colors.ink[900]} />
      </Pressable>

      <Text variant="h2" accessibilityRole="header" style={styles.title}>
        Plan your ride
      </Text>

      <View style={styles.inputCard}>
        <View style={[styles.fieldRow, active === "pickup" && styles.fieldRowActive]}>
          <View style={styles.pickupDot} />
          <View style={styles.inputColumn}>
            <TextInput
              ref={pickupInput}
              value={pickupText}
              onChangeText={(text) => {
                setPickupText(text);
                if (pickup && text !== pickup.label) setPickup(null);
              }}
              onFocus={() => setActive("pickup")}
              placeholder={locating ? "Finding where you are…" : "Pickup"}
              placeholderTextColor={colors.ink[300]}
              style={styles.input}
              autoCorrect={false}
              autoCapitalize="words"
              selectTextOnFocus
              returnKeyType="search"
              accessibilityLabel={pickupSubtitle ? `Pickup, ${pickupText}, ${pickupSubtitle}` : "Pickup"}
            />
            {pickupSubtitle && pickupText === pickup?.label ? (
              <Text variant="caption" color="muted" numberOfLines={1} style={styles.subtitle}>
                {pickupSubtitle}
              </Text>
            ) : null}
          </View>
          {pickupText ? (
            <ClearButton
              label="Clear pickup"
              onPress={() => {
                setPickupText("");
                setPickup(null);
                focus("pickup");
              }}
            />
          ) : null}
        </View>

        <View style={styles.inputDivider} />

        <View style={[styles.fieldRow, active === "dropoff" && styles.fieldRowActive]}>
          <View style={styles.dropoffSquare} />
          <TextInput
            ref={dropoffInput}
            value={dropoffText}
            onChangeText={(text) => {
              setDropoffText(text);
              if (dropoff && text !== dropoff.label) setDropoff(null);
            }}
            onFocus={() => setActive("dropoff")}
            placeholder="Where to?"
            placeholderTextColor={colors.ink[300]}
            style={[styles.input, styles.inputStrong]}
            autoCorrect={false}
            autoCapitalize="words"
            autoFocus={!dropoff}
            selectTextOnFocus
            returnKeyType="search"
            accessibilityLabel="Drop-off"
          />
          {dropoffText ? (
            <ClearButton
              label="Clear drop-off"
              onPress={() => {
                setDropoffText("");
                setDropoff(null);
                focus("dropoff");
              }}
            />
          ) : null}
        </View>
      </View>

      {problem ? (
        <View style={styles.problem} accessibilityLiveRegion="polite" accessibilityRole="alert">
          <Ionicons name="alert-circle" size={18} color={colors.danger} />
          <Text variant="bodySmall" style={styles.problemText}>
            {problem}
          </Text>
        </View>
      ) : null}

      {bothSet ? (
        <View style={styles.continue}>
          <Button
            label="Continue"
            disabled={problem !== null}
            onPress={() => proceed(pickup, dropoff, "dropoff")}
            accessibilityHint={problem ?? undefined}
          />
        </View>
      ) : null}

      <Card style={styles.list}>
        {active === "pickup" ? (
          <>
            <ListRow
              title={CURRENT_LOCATION_LABEL}
              subtitle={locating ? "Finding where you are…" : "Use where you are now"}
              leading={<ListRow.Icon name="navigate" color={colors.primary[500]} background={colors.primary[50]} />}
              showChevron={false}
              onPress={() => void pickCurrentLocation()}
              accessibilityLabel="Use my current location as the pickup"
            />
            <View style={styles.divider} />
          </>
        ) : null}
        <ListRow
          title="Choose on map"
          subtitle={active === "pickup" ? "Drop a pin where you'll be" : "Drop a pin where you're going"}
          leading={<ListRow.Icon name="map-outline" color={colors.ink[700]} background={colors.surfaceMuted} />}
          onPress={chooseOnMap}
          accessibilityLabel={`Choose the ${active === "pickup" ? "pickup" : "drop-off"} on a map`}
        />
      </Card>

      {placesError ? (
        <View style={styles.error}>
          <Text variant="bodySmall" color="muted">
            Couldn&apos;t load campus places. Check your connection.
          </Text>
          <Button label="Try again" variant="secondary" onPress={() => void refetchPlaces()} />
        </View>
      ) : listsLoading ? (
        <>
          <Text variant="h3" style={styles.sectionTitle}>
            Places
          </Text>
          <Card>
            <SkeletonGroup label="Loading places">
              <SkeletonListRows count={4} />
            </SkeletonGroup>
          </Card>
        </>
      ) : query ? (
        results.length > 0 ? (
          <EndSection
            title="Places"
            ends={results.map((p) => ({ end: placeEnd(p), icon: CATEGORY_ICON[p.category] }))}
            onChoose={(end) => choose(end)}
          />
        ) : (
          <Text variant="bodySmall" color="muted" style={styles.noMatch}>
            No campus places match “{query}”. Try another name, or choose on the map.
          </Text>
        )
      ) : (
        <>
          {recent.filter((e) => !isSameSpot(e, otherEnd)).length > 0 ? (
            <EndSection
              title="Recent"
              ends={recent.filter((e) => !isSameSpot(e, otherEnd)).map((end) => ({ end, icon: "time-outline" as const }))}
              onChoose={(end) => choose(end)}
            />
          ) : null}
          {popular.length > 0 ? (
            <EndSection
              title="Popular on campus"
              ends={popular
                .filter((p) => !isSameSpot(placeEnd(p), otherEnd))
                .map((p) => ({ end: placeEnd(p), icon: CATEGORY_ICON[p.category] }))}
              onChoose={(end) => choose(end)}
            />
          ) : null}
        </>
      )}

      {places && places.length > 0 ? (
        <Text variant="caption" color="muted" style={styles.attribution}>
          Places {PLACES_ATTRIBUTION}
        </Text>
      ) : null}
    </Screen>
  );
}

function ClearButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
      <Ionicons name="close-circle" size={20} color={colors.ink[300]} />
    </Pressable>
  );
}

function EndSection({
  title,
  ends,
  onChoose,
}: {
  title: string;
  ends: { end: TripEnd; icon: IconName }[];
  onChoose: (end: TripEnd) => void;
}) {
  if (ends.length === 0) return null;
  return (
    <>
      <Text variant="h3" style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      <Card style={styles.list}>
        {ends.map(({ end, icon }, index) => (
          <View key={`${end.placeId ?? ""}:${end.latitude.toFixed(5)},${end.longitude.toFixed(5)}`}>
            <ListRow
              title={end.label}
              leading={<ListRow.Icon name={icon} color={colors.ink[500]} background={colors.surfaceMuted} />}
              showChevron={false}
              onPress={() => onChoose(end)}
              accessibilityLabel={end.label}
            />
            {index < ends.length - 1 ? <View style={styles.divider} /> : null}
          </View>
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  back: {
    width: 44,
    height: 44,
    marginLeft: -spacing.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { marginTop: spacing.xs, marginBottom: spacing.lg },
  inputCard: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    ...shadows.md,
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
  },
  fieldRowActive: { backgroundColor: colors.surface },
  inputColumn: { flex: 1 },
  subtitle: { marginTop: -spacing.xs, marginBottom: spacing.xs },
  pickupDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.primary[500],
  },
  dropoffSquare: {
    width: 10,
    height: 10,
    borderRadius: 2,
    backgroundColor: colors.ink[900],
  },
  input: {
    flex: 1,
    fontSize: typography.size.md,
    color: colors.ink[900],
    paddingVertical: spacing.sm,
  },
  inputStrong: { fontWeight: typography.weight.semibold },
  inputDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginLeft: spacing.sm + 10 + spacing.md,
  },
  problem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.errorSurface,
  },
  problemText: { flex: 1, color: colors.danger },
  continue: { marginTop: spacing.md },
  sectionTitle: { marginTop: spacing.xl, marginBottom: spacing.sm },
  list: { paddingVertical: spacing.xs, marginTop: spacing.md },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  noMatch: { marginTop: spacing.xl, textAlign: "center" },
  error: { marginTop: spacing.xl, gap: spacing.md },
  attribution: { marginTop: spacing.lg, textAlign: "center" },
});
