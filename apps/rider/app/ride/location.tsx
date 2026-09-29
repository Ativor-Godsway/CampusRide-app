import { useEffect, useMemo, useRef, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Zone } from "@rida/shared";
import { placeSuggestions, recentDestinations } from "@rida/shared";
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
import { chooseRideParams, useResolvePickup, useZones } from "../../lib/chooseRide";

type Field = "pickup" | "dropoff";

/**
 * Plan your ride: a light pickup/drop-off card, then "Recent" and "Popular
 * on campus", filtered as the rider types. Tapping a place fills the active
 * field; once both ends are known it goes straight to Choose a ride — there
 * is no Continue button.
 *
 * Optional params pre-fill the fields: `dropoffZoneId` (a recent place from
 * Home when we couldn't tell where the rider is) and `pickupZoneId` (Edit
 * route from Choose a ride).
 */
export default function PlanRideScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ pickupZoneId?: string; dropoffZoneId?: string }>();
  const resolvePickup = useResolvePickup();

  const { data: zones, isLoading: zonesLoading, isError: zonesError, refetch: refetchZones } = useZones();
  const { data: rides, isLoading: ridesLoading } = useQuery<RideSummary[]>({
    queryKey: myRidesQueryKeys.recent,
    queryFn: () => getRecentRides(10),
  });

  const [pickup, setPickup] = useState<Zone | null>(null);
  const [dropoff, setDropoff] = useState<Zone | null>(null);
  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [active, setActive] = useState<Field>("dropoff");
  const [locating, setLocating] = useState(false);
  const pickupInput = useRef<TextInput>(null);
  const dropoffInput = useRef<TextInput>(null);

  // Pre-fill once the zone list is in: from params, else pickup = where the
  // rider is now (nearest campus zone).
  const prefilled = useRef(false);
  useEffect(() => {
    if (prefilled.current || !zones) return;
    prefilled.current = true;
    const byId = (id?: string) => (id ? (zones.find((z) => z.id === id) ?? null) : null);
    const presetDropoff = byId(params.dropoffZoneId);
    const presetPickup = byId(params.pickupZoneId);
    if (presetDropoff) {
      setDropoff(presetDropoff);
      setDropoffText(presetDropoff.name);
    }
    if (presetPickup) {
      setPickup(presetPickup);
      setPickupText(presetPickup.name);
      return;
    }
    if (presetDropoff) {
      // Destination known, start unknown: ask for the start.
      setActive("pickup");
      pickupInput.current?.focus();
    }
    setLocating(true);
    void resolvePickup()
      .then((zone) => {
        if (!zone || zone.id === presetDropoff?.id) return;
        // Only fill if the rider hasn't typed their own pickup meanwhile.
        setPickup((current) => current ?? zone);
        setPickupText((current) => current || zone.name);
      })
      .finally(() => setLocating(false));
  }, [zones, params.dropoffZoneId, params.pickupZoneId, resolvePickup]);

  const recent = useMemo(() => recentDestinations(rides ?? [], 3), [rides]);

  // A field showing its selected zone's own name isn't a search — show the
  // full lists so the rider can pick something else.
  const activeText = active === "pickup" ? pickupText : dropoffText;
  const activeZone = active === "pickup" ? pickup : dropoff;
  const query = activeZone && activeText === activeZone.name ? "" : activeText;
  const otherZone = active === "pickup" ? dropoff : pickup;

  const suggestions = useMemo(
    () =>
      placeSuggestions({
        zones: zones ?? [],
        recent,
        query,
        excludeZoneId: otherZone?.id ?? null,
      }),
    [zones, recent, query, otherZone?.id],
  );

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }

  function choose(zone: Zone) {
    const nextPickup = active === "pickup" ? zone : pickup;
    const nextDropoff = active === "dropoff" ? zone : dropoff;
    if (active === "pickup") {
      setPickup(zone);
      setPickupText(zone.name);
    } else {
      setDropoff(zone);
      setDropoffText(zone.name);
    }

    if (nextPickup && nextDropoff && nextPickup.id !== nextDropoff.id) {
      router.push({ pathname: "/ride/type", params: chooseRideParams(nextPickup, nextDropoff, "plan") });
      return;
    }
    // The other end is still missing: move straight to it.
    const next: Field = active === "pickup" ? "dropoff" : "pickup";
    setActive(next);
    (next === "pickup" ? pickupInput : dropoffInput).current?.focus();
  }

  const listsLoading = zonesLoading || ridesLoading;
  const placesTitle = query ? "Places" : "Popular on campus";

  return (
    <Screen scroll>
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
        style={styles.back}
      >
        <Ionicons name="arrow-back" size={24} color={colors.ink[900]} />
      </Pressable>

      <Text variant="h2" accessibilityRole="header" style={styles.title}>
        Plan your ride
      </Text>

      <View style={styles.inputCard}>
        <View style={[styles.fieldRow, active === "pickup" && styles.fieldRowActive]}>
          <View style={styles.pickupDot} />
          <TextInput
            ref={pickupInput}
            value={pickupText}
            onChangeText={(text) => {
              setPickupText(text);
              if (pickup && text !== pickup.name) setPickup(null);
            }}
            onFocus={() => setActive("pickup")}
            placeholder={locating ? "Finding where you are…" : "Pickup"}
            placeholderTextColor={colors.ink[300]}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="words"
            selectTextOnFocus
            returnKeyType="search"
            accessibilityLabel="Pickup"
          />
          {pickupText ? (
            <Pressable
              onPress={() => {
                setPickupText("");
                setPickup(null);
                setActive("pickup");
                pickupInput.current?.focus();
              }}
              accessibilityRole="button"
              accessibilityLabel="Clear pickup"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={20} color={colors.ink[300]} />
            </Pressable>
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
              if (dropoff && text !== dropoff.name) setDropoff(null);
            }}
            onFocus={() => setActive("dropoff")}
            placeholder="Where to?"
            placeholderTextColor={colors.ink[300]}
            style={[styles.input, styles.inputStrong]}
            autoCorrect={false}
            autoCapitalize="words"
            autoFocus={!params.dropoffZoneId}
            selectTextOnFocus
            returnKeyType="search"
            accessibilityLabel="Drop-off"
          />
          {dropoffText ? (
            <Pressable
              onPress={() => {
                setDropoffText("");
                setDropoff(null);
                setActive("dropoff");
                dropoffInput.current?.focus();
              }}
              accessibilityRole="button"
              accessibilityLabel="Clear drop-off"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={20} color={colors.ink[300]} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {zonesError ? (
        <View style={styles.error}>
          <Text variant="bodySmall" color="muted">
            Couldn&apos;t load campus places. Check your connection.
          </Text>
          <Button label="Try again" variant="secondary" onPress={() => void refetchZones()} />
        </View>
      ) : listsLoading ? (
        <>
          <Text variant="h3" style={styles.sectionTitle}>
            Recent
          </Text>
          <Card>
            <SkeletonGroup label="Loading places">
              <SkeletonListRows count={4} />
            </SkeletonGroup>
          </Card>
        </>
      ) : (
        <>
          {suggestions.recent.length > 0 ? (
            <PlaceSection title="Recent" icon="time-outline" places={suggestions.recent} onChoose={choose} />
          ) : null}
          {suggestions.places.length > 0 ? (
            <PlaceSection title={placesTitle} icon="location-outline" places={suggestions.places} onChoose={choose} />
          ) : null}
          {suggestions.noMatch ? (
            <Text variant="bodySmall" color="muted" style={styles.noMatch}>
              No campus places match “{query.trim()}”.
            </Text>
          ) : null}
        </>
      )}
    </Screen>
  );
}

function PlaceSection({
  title,
  icon,
  places,
  onChoose,
}: {
  title: string;
  icon: "time-outline" | "location-outline";
  places: Zone[];
  onChoose: (zone: Zone) => void;
}) {
  return (
    <>
      <Text variant="h3" style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      <Card style={styles.list}>
        {places.map((zone, index) => (
          <View key={zone.id}>
            <ListRow
              title={zone.name}
              leading={<ListRow.Icon name={icon} color={colors.ink[500]} background={colors.surfaceMuted} />}
              showChevron={false}
              onPress={() => onChoose(zone)}
              accessibilityLabel={zone.name}
            />
            {index < places.length - 1 ? <View style={styles.divider} /> : null}
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
  sectionTitle: { marginTop: spacing.xl, marginBottom: spacing.sm },
  list: { paddingVertical: spacing.xs },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xs },
  noMatch: { marginTop: spacing.xl, textAlign: "center" },
  error: { marginTop: spacing.xl, gap: spacing.md },
});
