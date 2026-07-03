import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import type { Zone } from "@rida/shared";
import { nearestZone } from "@rida/shared";
import {
  AnimatedPressable,
  Button,
  Card,
  Chip,
  ListRow,
  LoadingState,
  RouteStops,
  Screen,
  SheetHandle,
  Text,
  brand,
  colors,
  getMyRides,
  getZones,
  motion,
  radii,
  spacing,
  useCurrentLocation,
  type RideSummary,
} from "@rida/mobile-shared";

type ActiveField = "pickup" | "dropoff";

const CAMPUS_SPOT_COUNT = 8;
const RECENT_COUNT = 3;

export default function LocationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { requestLocation } = useCurrentLocation();

  const { data: zones, isLoading, isError } = useQuery<Zone[]>({
    queryKey: ["zones"],
    queryFn: getZones,
  });
  // Same cache Home already populates — recents derive from it, no new endpoint.
  const { data: myRides } = useQuery<RideSummary[]>({ queryKey: ["myRides"], queryFn: getMyRides });

  const zoneList: Zone[] = zones ?? [];

  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [activeField, setActiveField] = useState<ActiveField>("dropoff");
  const [located, setLocated] = useState(false);

  const dropoffRef = useRef<TextInput>(null);
  const topOffset = insets.top + spacing.lg;

  // ── Sheet entrance / dismissal (transform + opacity only) ────────────────────
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withSpring(1, motion.spring.gentle);
    // Pop the keyboard only once the sheet has landed — focusing during the
    // spring makes the two animations fight.
    const focusTimer = setTimeout(() => dropoffRef.current?.focus(), 420);
    return () => {
      clearTimeout(focusTimer);
      cancelAnimation(progress);
    };
  }, [progress]);

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * 0.35 }));
  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * windowHeight }],
  }));

  const goBack = () => router.back();

  function dismiss() {
    Keyboard.dismiss();
    progress.value = withTiming(0, { duration: motion.duration.base }, (finished) => {
      if (finished) runOnJS(goBack)();
    });
  }

  // ── Zone resolution (unchanged matching logic) ───────────────────────────────
  useEffect(() => {
    if (located || zoneList.length === 0) return;
    setLocated(true);
    void (async () => {
      const coords = await requestLocation();
      if (!coords) return;
      const zone = nearestZone(coords.latitude, coords.longitude, zoneList);
      if (zone) setPickupText(zone.name);
    })();
  }, [located, zoneList, requestLocation]);

  const pickupZone = useMemo(
    () => zoneList.find((zone) => zone.name.toLowerCase() === pickupText.trim().toLowerCase()) ?? null,
    [zoneList, pickupText],
  );
  const dropoffZone = useMemo(
    () => zoneList.find((zone) => zone.name.toLowerCase() === dropoffText.trim().toLowerCase()) ?? null,
    [zoneList, dropoffText],
  );

  const activeText = activeField === "pickup" ? pickupText : dropoffText;
  const activeZone = activeField === "pickup" ? pickupZone : dropoffZone;

  const suggestions = useMemo(() => {
    const query = activeText.trim().toLowerCase();
    if (!query || activeZone) return [];
    return zoneList.filter((zone) => zone.name.toLowerCase().includes(query)).slice(0, 6);
  }, [zoneList, activeText, activeZone]);

  const showSuggestions = Boolean(activeText.trim() && !activeZone);
  const showNoMatch = showSuggestions && suggestions.length === 0;

  const campusSpots = zoneList.slice(0, CAMPUS_SPOT_COUNT);

  const recents = useMemo(() => {
    const seen = new Set<string>();
    const out: Zone[] = [];
    for (const ride of myRides ?? []) {
      if (seen.has(ride.dropoffZoneId)) continue;
      const zone = zoneList.find((z) => z.id === ride.dropoffZoneId);
      if (!zone) continue;
      seen.add(zone.id);
      out.push(zone);
      if (out.length === RECENT_COUNT) break;
    }
    return out;
  }, [myRides, zoneList]);

  /** Fills the active field with a zone; focus moves to whichever field is still unresolved. */
  function selectZone(zone: Zone) {
    if (activeField === "dropoff") {
      setDropoffText(zone.name);
      if (!pickupZone) setActiveField("pickup");
    } else {
      setPickupText(zone.name);
      if (!dropoffZone) setActiveField("dropoff");
    }
  }

  // ── Auto-advance once both ends resolve ──────────────────────────────────────
  // Keyed by the zone pair so returning from ride-select (same pair still set)
  // doesn't immediately re-advance; changing either field re-arms it.
  const advancedPairRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pickupZone || !dropoffZone || pickupZone.id === dropoffZone.id) return;
    const pair = `${pickupZone.id}:${dropoffZone.id}`;
    if (advancedPairRef.current === pair) return;
    Keyboard.dismiss();
    // Brief beat so the second selection is seen landing before the handoff.
    // The pair is latched only when the push actually fires — if the user
    // edits a field inside this beat, the timer clears and the pair re-arms.
    const timer = setTimeout(() => {
      advancedPairRef.current = pair;
      router.push({
        pathname: "/ride/type",
        params: {
          pickupZoneId: pickupZone.id,
          dropoffZoneId: dropoffZone.id,
          pickupZoneName: pickupZone.name,
          dropoffZoneName: dropoffZone.name,
          pickupLat: String(pickupZone.latitude),
          pickupLng: String(pickupZone.longitude),
          dropoffLat: String(dropoffZone.latitude),
          dropoffLng: String(dropoffZone.longitude),
        },
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [pickupZone, dropoffZone, router]);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (isLoading || isError || !zones) {
    // Data states render as a plain screen — no sheet theatrics over an error.
    return (
      <Screen>
        {isLoading ? (
          <LoadingState message="Loading campus zones..." />
        ) : (
          <View style={styles.errorContent}>
            <Text variant="h2">Couldn't load zones</Text>
            <Text variant="body" color="muted" style={styles.errorBody}>
              Check your connection and try again.
            </Text>
            <Button label="Back" variant="secondary" onPress={goBack} />
          </View>
        )}
      </Screen>
    );
  }

  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, backdropStyle]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Close location selection"
        />
      </Animated.View>

      <Animated.View style={[styles.sheet, { marginTop: topOffset }, sheetStyle]}>
        <SheetHandle />
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={topOffset}
        >
          <Text variant="title" style={styles.title}>
            Plan your ride
          </Text>

          <Card noPadding style={styles.fieldsCard}>
            <View style={styles.fieldsRow}>
              <View style={styles.markersCol}>
                <RouteStops.Markers connectorHeight={30} />
              </View>
              <View style={styles.fieldsCol}>
                <View style={[styles.fieldRow, activeField === "pickup" && styles.fieldRowActive]}>
                  <TextInput
                    value={pickupText}
                    onChangeText={(text) => {
                      setPickupText(text);
                      setActiveField("pickup");
                    }}
                    onFocus={() => setActiveField("pickup")}
                    placeholder="Pickup"
                    placeholderTextColor={colors.ink[300]}
                    selectionColor={brand.primary}
                    style={styles.fieldInput}
                    autoCorrect={false}
                    autoCapitalize="words"
                    accessibilityLabel="Pickup location"
                  />
                  {pickupText ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear pickup"
                      onPress={() => {
                        setPickupText("");
                        setActiveField("pickup");
                      }}
                      style={styles.clearButton}
                      hitSlop={8}
                    >
                      <Ionicons name="close-circle" size={18} color={colors.ink[300]} />
                    </Pressable>
                  ) : null}
                </View>

                <View style={styles.fieldDivider} />

                <View style={[styles.fieldRow, activeField === "dropoff" && styles.fieldRowActive]}>
                  <TextInput
                    ref={dropoffRef}
                    value={dropoffText}
                    onChangeText={(text) => {
                      setDropoffText(text);
                      setActiveField("dropoff");
                    }}
                    onFocus={() => setActiveField("dropoff")}
                    placeholder="Where to?"
                    placeholderTextColor={colors.ink[300]}
                    selectionColor={brand.primary}
                    style={styles.fieldInput}
                    autoCorrect={false}
                    autoCapitalize="words"
                    accessibilityLabel="Dropoff location"
                  />
                  {dropoffText ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear dropoff"
                      onPress={() => {
                        setDropoffText("");
                        setActiveField("dropoff");
                      }}
                      style={styles.clearButton}
                      hitSlop={8}
                    >
                      <Ionicons name="close-circle" size={18} color={colors.ink[300]} />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </View>
          </Card>

          <ScrollView
            style={styles.flex}
            contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.xl }]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {showSuggestions && suggestions.length > 0 ? (
              <Card noPadding style={styles.suggestionsCard}>
                {suggestions.map((zone, index) => (
                  <View key={zone.id}>
                    {index > 0 ? <View style={styles.rowDivider} /> : null}
                    <ListRow
                      title={zone.name}
                      subtitle={zone.quadrant}
                      leading={
                        <ListRow.Icon
                          name="location-outline"
                          color={colors.ink[500]}
                          background={colors.surfaceSunken}
                        />
                      }
                      showChevron={false}
                      onPress={() => selectZone(zone)}
                    />
                  </View>
                ))}
              </Card>
            ) : null}

            {showNoMatch ? (
              <View style={styles.noMatch}>
                <Text variant="bodySmall" color="muted">
                  No campus spot matches "{activeText.trim()}" — try another name.
                </Text>
              </View>
            ) : null}

            {!showSuggestions ? (
              <>
                <Text variant="label" color="muted" style={styles.sectionLabel}>
                  CAMPUS SPOTS
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.chipRow}
                  keyboardShouldPersistTaps="handled"
                >
                  {campusSpots.map((zone) => (
                    <Chip key={zone.id} label={zone.name} onPress={() => selectZone(zone)} />
                  ))}
                </ScrollView>

                {recents.length > 0 ? (
                  <>
                    <Text variant="label" color="muted" style={styles.sectionLabel}>
                      RECENT
                    </Text>
                    <Card noPadding style={styles.recentsCard}>
                      {recents.map((zone, index) => (
                        <View key={zone.id}>
                          {index > 0 ? <View style={styles.rowDivider} /> : null}
                          <AnimatedPressable
                            accessibilityRole="button"
                            accessibilityLabel={`Recent destination: ${zone.name}`}
                            onPress={() => selectZone(zone)}
                            style={styles.recentRow}
                          >
                            <ListRow.Icon
                              name="time-outline"
                              color={colors.ink[500]}
                              background={colors.surfaceSunken}
                            />
                            <View style={styles.recentBody}>
                              <Text variant="headline" numberOfLines={1}>
                                {zone.name}
                              </Text>
                              <Text variant="caption" color="muted">
                                {zone.quadrant}
                              </Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={colors.ink[300]} />
                          </AnimatedPressable>
                        </View>
                      ))}
                    </Card>
                  </>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  backdrop: {
    backgroundColor: colors.surfaceDark,
  },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.gutter,
  },
  title: {
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  fieldsCard: {
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  fieldsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  markersCol: {
    justifyContent: "center",
  },
  fieldsCol: {
    flex: 1,
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: "transparent",
    paddingHorizontal: spacing.sm,
  },
  fieldRowActive: {
    borderColor: brand.primary,
    backgroundColor: colors.surface,
  },
  fieldDivider: {
    height: 1,
    backgroundColor: colors.hairline,
    marginVertical: spacing.xs,
    marginHorizontal: spacing.sm,
  },
  fieldInput: {
    flex: 1,
    fontSize: 16,
    color: colors.ink[900],
    paddingVertical: 0,
    margin: 0,
  },
  clearButton: {
    padding: spacing.xs,
  },
  listContent: {
    gap: spacing.md,
  },
  suggestionsCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  rowDivider: {
    height: 1,
    backgroundColor: colors.hairline,
  },
  noMatch: {
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  sectionLabel: {
    marginTop: spacing.sm,
  },
  chipRow: {
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  recentsCard: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  recentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: 60,
  },
  recentBody: {
    flex: 1,
    gap: 2,
  },
  errorContent: { flex: 1, justifyContent: "center", gap: spacing.lg },
  errorBody: { marginBottom: spacing.md },
});
