import { useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Zone } from "@rida/shared";
import { nearestZone } from "@rida/shared";
import {
  Button,
  Card,
  LoadingState,
  Screen,
  Text,
  colors,
  getZones,
  radii,
  spacing,
  useCurrentLocation,
} from "@rida/mobile-shared";

type ActiveField = "pickup" | "dropoff" | null;

export default function LocationScreen() {
  const router = useRouter();
  const { requestLocation } = useCurrentLocation();

  const { data: zones, isLoading, isError } = useQuery<Zone[]>({
    queryKey: ["zones"],
    queryFn: getZones,
  });

  const zoneList: Zone[] = zones ?? [];

  const [pickupText, setPickupText] = useState("");
  const [dropoffText, setDropoffText] = useState("");
  const [activeField, setActiveField] = useState<ActiveField>("dropoff");
  const [located, setLocated] = useState(false);

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

  const activeText = activeField === "pickup" ? pickupText : activeField === "dropoff" ? dropoffText : "";
  const activeZone = activeField === "pickup" ? pickupZone : activeField === "dropoff" ? dropoffZone : null;

  const suggestions = useMemo(() => {
    const query = activeText.trim().toLowerCase();
    if (!activeField || !query || activeZone) return [];
    return zoneList.filter((zone) => zone.name.toLowerCase().includes(query)).slice(0, 6);
  }, [zoneList, activeText, activeField, activeZone]);

  const showSuggestions = Boolean(activeField && activeText.trim() && !activeZone);
  const showNoMatch = showSuggestions && suggestions.length === 0;

  function selectSuggestion(zone: Zone) {
    if (activeField === "dropoff") {
      setDropoffText(zone.name);
      setActiveField(pickupZone ? null : "pickup");
    } else {
      setPickupText(zone.name);
      setActiveField(dropoffZone ? null : "dropoff");
    }
  }

  function handleContinue() {
    if (!pickupZone || !dropoffZone) return;
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
  }

  if (isLoading) {
    return (
      <Screen>
        <LoadingState message="Loading campus zones..." />
      </Screen>
    );
  }

  if (isError || !zones) {
    return (
      <Screen>
        <View style={styles.errorContent}>
          <Text variant="h2">Couldn't load zones</Text>
          <Text variant="body" color="muted" style={styles.errorBody}>
            Check your connection and try again.
          </Text>
          <Button label="Back" variant="secondary" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  const canContinue = Boolean(
    pickupZone && dropoffZone && pickupZone.id !== dropoffZone.id,
  );

  return (
    <Screen scroll>
      <Text variant="h1">Plan your ride</Text>
      <Text variant="bodySmall" color="muted" style={styles.subtitle}>
        Choose where you're starting and where you're headed.
      </Text>

      <Card dark style={styles.planCard}>
        <View style={[styles.fieldRow, activeField === "pickup" && styles.fieldRowActive]}>
          <View style={styles.markerCol}>
            <View style={styles.pickupDot} />
            <View style={styles.connector} />
          </View>
          <View style={styles.fieldTextCol}>
            <Text variant="label" style={styles.fieldLabel}>
              PICKUP
            </Text>
            <TextInput
              value={pickupText}
              onChangeText={(text) => {
                setPickupText(text);
                setActiveField("pickup");
              }}
              onFocus={() => setActiveField("pickup")}
              placeholder="Current location"
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={styles.fieldInput}
              autoCorrect={false}
              autoCapitalize="words"
            />
          </View>
          {pickupText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear pickup"
              onPress={() => {
                setPickupText("");
                setActiveField("pickup");
              }}
              style={styles.clearButton}
            >
              <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.5)" />
            </Pressable>
          ) : null}
        </View>

        <View style={[styles.fieldRow, activeField === "dropoff" && styles.fieldRowActive]}>
          <View style={styles.markerCol}>
            <Ionicons name="location" size={16} color={colors.white} />
          </View>
          <View style={styles.fieldTextCol}>
            <Text variant="label" style={styles.fieldLabel}>
              DROPOFF
            </Text>
            <TextInput
              value={dropoffText}
              onChangeText={(text) => {
                setDropoffText(text);
                setActiveField("dropoff");
              }}
              onFocus={() => setActiveField("dropoff")}
              placeholder="Where to?"
              placeholderTextColor="rgba(255,255,255,0.4)"
              style={styles.fieldInput}
              autoCorrect={false}
              autoCapitalize="words"
              autoFocus
            />
          </View>
          {dropoffText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Clear dropoff"
              onPress={() => {
                setDropoffText("");
                setActiveField("dropoff");
              }}
              style={styles.clearButton}
            >
              <Ionicons name="close-circle" size={18} color="rgba(255,255,255,0.5)" />
            </Pressable>
          ) : null}
        </View>
      </Card>

      {showSuggestions ? (
        <Card noPadding style={styles.suggestionsCard}>
          {suggestions.map((zone, index) => (
            <Pressable
              key={zone.id}
              accessibilityRole="button"
              onPress={() => selectSuggestion(zone)}
              style={[styles.suggestionRow, index > 0 && styles.suggestionRowDivider]}
            >
              <Ionicons name="location-outline" size={18} color={colors.ink[400]} />
              <View style={styles.suggestionTextCol}>
                <Text variant="bodyMedium">{zone.name}</Text>
                <Text variant="caption" color="muted">
                  {zone.quadrant}
                </Text>
              </View>
            </Pressable>
          ))}
        </Card>
      ) : null}

      {showNoMatch ? (
        <Text variant="bodySmall" color="error" style={styles.noMatch}>
          No matching zone
        </Text>
      ) : null}

      <View style={styles.continueButton}>
        <Button label="Continue" onPress={handleContinue} disabled={!canContinue} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { marginTop: spacing.xs, marginBottom: spacing.lg },
  planCard: { gap: 0 },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.md,
  },
  fieldRowActive: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  markerCol: {
    width: 20,
    alignItems: "center",
  },
  pickupDot: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    backgroundColor: colors.primary[400],
  },
  connector: {
    width: 1,
    height: 24,
    backgroundColor: colors.borderDark,
    marginVertical: 4,
  },
  fieldTextCol: {
    flex: 1,
    gap: 2,
  },
  fieldLabel: {
    color: "rgba(255,255,255,0.5)",
  },
  fieldInput: {
    color: colors.white,
    fontSize: 16,
    paddingVertical: 0,
    margin: 0,
  },
  clearButton: {
    padding: spacing.xs,
  },
  suggestionsCard: {
    marginTop: spacing.md,
  },
  suggestionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  suggestionRowDivider: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  suggestionTextCol: {
    flex: 1,
    gap: 2,
  },
  noMatch: {
    marginTop: spacing.sm,
  },
  continueButton: { marginTop: spacing.xl, marginBottom: spacing.xl },
  errorContent: { flex: 1, justifyContent: "center", gap: spacing.lg },
  errorBody: { marginBottom: spacing.md },
});
