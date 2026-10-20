import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { CampusPlace, TripEnd } from "@rida/shared";
import {
  CURRENT_LOCATION_LABEL,
  PLACES_ATTRIBUTION,
  PLACE_CATEGORY_LABELS,
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
  ListRow,
  Notice,
  Screen,
  SkeletonGroup,
  SkeletonListRows,
  Text,
  colors,
  fonts,
  getRecentRides,
  myRidesQueryKeys,
  radii,
  spacing,
  type RideSummary,
} from "@rida/mobile-shared";
import { chooseRideParams, usePlaces, useResolvePickup } from "../../lib/chooseRide";
import { setPickedPin, usePickedPin } from "../../lib/planDraft";

type Field = "pickup" | "dropoff";
type IconName = ComponentProps<typeof Ionicons>["name"];

/** A place's icon: its category's, or a closer one its name gives away. */
function placeIcon(place: Pick<CampusPlace, "name" | "category">): IconName {
  if (/librar/i.test(place.name)) return "library-outline";
  if (/stadium|sport|gym|pitch|pool/i.test(place.name)) return "football-outline";
  switch (place.category) {
    case "HALL":
      return "bed-outline";
    case "HOSTEL":
      return "home-outline";
    case "FACULTY":
      return "school-outline";
    case "GATE":
      return "enter-outline";
    case "FOOD":
      return "restaurant-outline";
    default:
      return "location-outline";
  }
}

/** A row in one of the lists: a place (with its icon and category) or a pin. */
interface PlaceRow {
  end: TripEnd;
  icon: IconName;
  subtitle?: string;
}

/** What went wrong, under the field it's about. */
interface Problem {
  field: Field;
  message: string;
}

/** The spec's wording for an end outside the area (tripEndProblem decides). */
const OUTSIDE: Record<Field, string> = {
  pickup: "Pickup is outside the campus area. Move the pin inside UG Legon.",
  dropoff: "Drop-off is outside the campus area. Choose a place inside UG Legon.",
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

  const {
    data: places,
    isLoading: placesLoading,
    isError: placesError,
    refetch: refetchPlaces,
  } = usePlaces();
  const { data: rides, isLoading: ridesLoading } = useQuery<RideSummary[]>({
    queryKey: myRidesQueryKeys.recent,
    queryFn: () => getRecentRides(10),
  });

  const [pickup, setPickup] = useState<TripEnd | null>(() => tripEndFromParams("pickup", params));
  const [dropoff, setDropoff] = useState<TripEnd | null>(() =>
    tripEndFromParams("dropoff", params),
  );
  const [pickupText, setPickupText] = useState(pickup?.label ?? "");
  const [dropoffText, setDropoffText] = useState(dropoff?.label ?? "");
  const [active, setActive] = useState<Field>(dropoff && !pickup ? "pickup" : "dropoff");
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Where the two fields sit, so the line runs from the dot to the square
  // whatever their height (the pickup can have a second line).
  const [pickupBox, setPickupBox] = useState<{ y: number; height: number } | null>(null);
  const [dropoffBox, setDropoffBox] = useState<{ y: number; height: number } | null>(null);
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
        if (tripEndProblem(here, "pickup"))
          setProblem({ field: "pickup", message: OUTSIDE.pickup });
      })
      .finally(() => setLocating(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recent = useMemo(() => recentTripEnds(rides ?? [], places ?? null, 3), [rides, places]);
  const popular = useMemo(() => {
    const byName = new Map((places ?? []).map((p) => [p.name.toLowerCase(), p]));
    return POPULAR_PLACE_NAMES.map((n) => byName.get(n.toLowerCase())).filter(
      (p): p is CampusPlace => !!p,
    );
  }, [places]);

  // A field showing its chosen end's own label isn't a search.
  const activeText = active === "pickup" ? pickupText : dropoffText;
  const activeEnd = active === "pickup" ? pickup : dropoff;
  const otherEnd = active === "pickup" ? dropoff : pickup;
  const query = activeEnd && activeText === activeEnd.label ? "" : activeText.trim();
  const results = useMemo(
    () =>
      query
        ? searchPlaces(places ?? [], query, 8).filter((p) => !isSameSpot(placeEnd(p), otherEnd))
        : [],
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
    if (nextPickup && tripEndProblem(nextPickup, "pickup")) {
      setProblem({ field: "pickup", message: OUTSIDE.pickup });
      return;
    }
    if (nextDropoff && tripEndProblem(nextDropoff, "dropoff")) {
      setProblem({ field: "dropoff", message: OUTSIDE.dropoff });
      return;
    }
    if (nextPickup && nextDropoff) {
      if (isSameSpot(nextPickup, nextDropoff)) {
        setProblem({
          field: "dropoff",
          message: "Your pickup and drop-off are the same place. Choose a different drop-off.",
        });
        return;
      }
      setProblem(null);
      router.push({
        pathname: "/ride/type",
        params: chooseRideParams(nextPickup, nextDropoff, "plan"),
      });
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
      else
        setProblem({
          field: "pickup",
          message: "We couldn't find where you are. Turn on location, or search for your pickup.",
        });
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

  /** A place from the list, with its icon and category; anything else as a pin. */
  const rowFor = (end: TripEnd, fallbackIcon: IconName): PlaceRow => {
    const place = end.placeId ? places?.find((p) => p.id === end.placeId) : undefined;
    return place
      ? { end, icon: placeIcon(place), subtitle: PLACE_CATEGORY_LABELS[place.category] }
      : { end, icon: fallbackIcon };
  };
  const recentRows = recent
    .filter((e) => !isSameSpot(e, otherEnd))
    .map((e) => rowFor(e, "time-outline"));
  const popularRows = popular
    // Not twice: a recent place stays under Recent.
    .filter(
      (p) =>
        !isSameSpot(placeEnd(p), otherEnd) &&
        !recentRows.some((r) => isSameSpot(r.end, placeEnd(p))),
    )
    .map((p) => rowFor(placeEnd(p), "location-outline"));
  const chooseOnMapRow = (
    <ListRow
      title="Choose on map"
      subtitle={
        active === "pickup" ? "Drop a pin where you'll be" : "Drop a pin where you're going"
      }
      leading={<ListRow.Icon name="map-outline" />}
      onPress={chooseOnMap}
      accessibilityLabel={`Choose the ${active === "pickup" ? "pickup" : "drop-off"} on a map`}
    />
  );

  return (
    <Screen scroll style={styles.page}>
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={4}
        style={({ pressed }) => [styles.back, pressed && styles.backPressed]}
      >
        <Ionicons name="arrow-back" size={22} color={colors.ink} />
      </Pressable>

      <Text variant="title1" accessibilityRole="header" style={styles.title}>
        Where to?
      </Text>

      {/* Both ends in one block: the green pickup dot and the ink drop-off
          square, joined by a thin line. The field being edited is white with
          a green border. */}
      <View style={styles.fields}>
        {pickupBox && dropoffBox && problem?.field !== "pickup" ? (
          <View
            style={[
              styles.connector,
              {
                top: pickupBox.y + pickupBox.height / 2 + MARKER,
                height:
                  dropoffBox.y +
                  dropoffBox.height / 2 -
                  MARKER -
                  (pickupBox.y + pickupBox.height / 2 + MARKER),
              },
            ]}
          />
        ) : null}
        <View
          onLayout={(e) => setPickupBox(e.nativeEvent.layout)}
          style={[styles.field, active === "pickup" && styles.fieldActive]}
        >
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
              placeholderTextColor={colors.ink3}
              style={styles.input}
              autoCorrect={false}
              autoCapitalize="words"
              selectTextOnFocus
              returnKeyType="search"
              accessibilityLabel={
                pickupSubtitle ? `Pickup, ${pickupText}, ${pickupSubtitle}` : "Pickup"
              }
            />
            {pickupSubtitle && pickupText === pickup?.label ? (
              <Text variant="caption" color="tertiary" numberOfLines={1} style={styles.subtitle}>
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

        {problem?.field === "pickup" ? (
          <Notice tone="warning" message={problem.message} style={styles.fieldNotice} />
        ) : null}

        <View
          onLayout={(e) => setDropoffBox(e.nativeEvent.layout)}
          style={[styles.field, active === "dropoff" && styles.fieldActive]}
        >
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
            placeholderTextColor={colors.ink3}
            style={styles.input}
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

      {problem?.field === "dropoff" ? (
        <Notice tone="warning" message={problem.message} style={styles.dropoffNotice} />
      ) : null}

      {bothSet ? (
        <View style={styles.continue}>
          <Button
            label="Continue"
            disabled={problem !== null}
            onPress={() => proceed(pickup, dropoff, "dropoff")}
            accessibilityHint={problem?.message}
          />
        </View>
      ) : null}

      {placesError ? (
        <View style={styles.section}>
          <Notice
            tone="error"
            message="Couldn't load campus places. Check your connection and try again."
          />
          <Button label="Try again" variant="secondary" onPress={() => void refetchPlaces()} />
        </View>
      ) : listsLoading ? (
        <View style={styles.section}>
          <SkeletonGroup label="Loading places">
            <SkeletonListRows count={4} />
          </SkeletonGroup>
        </View>
      ) : query ? (
        // Searching: only what matches, or a way out.
        <View style={styles.section}>
          {results.length > 0 ? (
            <PlaceRows
              rows={results.map((p) => rowFor(placeEnd(p), "location-outline"))}
              onChoose={(end) => choose(end)}
            />
          ) : (
            <>
              <Text variant="body" color="secondary" style={styles.noMatch}>
                No places match &ldquo;{query}&rdquo;
              </Text>
              {chooseOnMapRow}
            </>
          )}
        </View>
      ) : (
        <>
          <View style={styles.section}>
            {active === "pickup" ? (
              <ListRow
                title={CURRENT_LOCATION_LABEL}
                subtitle={locating ? "Finding where you are…" : "Use where you are now"}
                leading={<ListRow.Icon name="navigate" tone="brand" />}
                showChevron={false}
                onPress={() => void pickCurrentLocation()}
                accessibilityLabel="Use my current location as the pickup"
              />
            ) : null}
            {active === "pickup" ? <View style={styles.rowDivider} /> : null}
            {chooseOnMapRow}
          </View>
          {recentRows.length > 0 ? (
            <View style={styles.section}>
              <Text variant="title3" accessibilityRole="header" style={styles.sectionTitle}>
                Recent
              </Text>
              <PlaceRows rows={recentRows} onChoose={(end) => choose(end)} />
            </View>
          ) : null}
          {popularRows.length > 0 ? (
            <View style={styles.section}>
              <Text variant="title3" accessibilityRole="header" style={styles.sectionTitle}>
                Popular on campus
              </Text>
              <PlaceRows rows={popularRows} onChoose={(end) => choose(end)} />
            </View>
          ) : null}
        </>
      )}

      {places && places.length > 0 ? (
        <Text variant="caption" color="tertiary" style={styles.attribution}>
          Places {PLACES_ATTRIBUTION}
        </Text>
      ) : null}
    </Screen>
  );
}

function ClearButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}>
      <Ionicons name="close-circle" size={20} color={colors.ink3} />
    </Pressable>
  );
}

/** Flat rows (no card): icon tile, name, category; inset dividers between them. */
function PlaceRows({ rows, onChoose }: { rows: PlaceRow[]; onChoose: (end: TripEnd) => void }) {
  return (
    <View>
      {rows.map(({ end, icon, subtitle }, index) => (
        <ListRow
          key={`${end.placeId ?? ""}:${end.latitude.toFixed(5)},${end.longitude.toFixed(5)}`}
          divider={index > 0}
          title={end.label}
          subtitle={subtitle}
          leading={<ListRow.Icon name={icon} />}
          showChevron={false}
          onPress={() => onChoose(end)}
          accessibilityLabel={subtitle ? `${end.label}, ${subtitle}` : end.label}
        />
      ))}
    </View>
  );
}

const FIELD_HEIGHT = 56;
const FIELDS_PADDING = 4;
const MARKER = 10;

const styles = StyleSheet.create({
  page: { paddingBottom: spacing[10] },
  back: {
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  backPressed: { backgroundColor: colors.surface3 },
  title: { marginTop: spacing[6], marginBottom: spacing[5] },
  fields: {
    backgroundColor: colors.surface2,
    borderRadius: radii.lg,
    padding: FIELDS_PADDING,
    gap: FIELDS_PADDING,
  },
  // From under the pickup dot to above the drop-off square.
  connector: {
    position: "absolute",
    left: FIELDS_PADDING + spacing[4] + MARKER / 2 - 1,
    width: 2,
    borderRadius: 1,
    backgroundColor: colors.lineStrong,
    opacity: 0.5,
  },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    minHeight: FIELD_HEIGHT,
    paddingHorizontal: spacing[4] - 2,
    borderRadius: radii.md,
    // Always 2px, so focusing doesn't shift the text.
    borderWidth: 2,
    borderColor: "transparent",
  },
  fieldActive: { backgroundColor: colors.surface, borderColor: colors.green500 },
  fieldNotice: { marginHorizontal: spacing[1] },
  dropoffNotice: { marginTop: spacing[2] },
  inputColumn: { flex: 1 },
  subtitle: { marginTop: -spacing[1], marginBottom: spacing[1] },
  pickupDot: {
    width: MARKER,
    height: MARKER,
    borderRadius: radii.full,
    backgroundColor: colors.green500,
  },
  dropoffSquare: {
    width: MARKER,
    height: MARKER,
    borderRadius: 2,
    backgroundColor: colors.ink,
  },
  input: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: colors.ink,
    paddingVertical: spacing[2],
  },
  continue: { marginTop: spacing[4] },
  section: { marginTop: spacing[6] },
  sectionTitle: { marginBottom: spacing[1] },
  rowDivider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginLeft: 56 },
  noMatch: { marginBottom: spacing[2] },
  attribution: { marginTop: spacing[8], textAlign: "center" },
});
