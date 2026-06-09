import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { Zone } from "@rida/shared";
import { nearestZone } from "@rida/shared";
import {
  Badge,
  Button,
  Card,
  Input,
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
  const { status: locationStatus, requestLocation } = useCurrentLocation();

  const { data: zones, isLoading, isError } = useQuery<Zone[]>({
    queryKey: ["zones"],
    queryFn: getZones,
  });

  const [pickupZoneId, setPickupZoneId] = useState<string | null>(null);
  const [dropoffZoneId, setDropoffZoneId] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<ActiveField>("pickup");
  const [search, setSearch] = useState("");

  const zoneList: Zone[] = zones ?? [];

  const zoneById = useMemo(() => {
    const map = new Map<string, Zone>();
    for (const zone of zoneList) map.set(zone.id, zone);
    return map;
  }, [zoneList]);

  const pickupZone = pickupZoneId ? zoneById.get(pickupZoneId) ?? null : null;
  const dropoffZone = dropoffZoneId ? zoneById.get(dropoffZoneId) ?? null : null;

  const filteredZones = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return zoneList;
    return zoneList.filter((zone) => zone.name.toLowerCase().includes(query));
  }, [zoneList, search]);

  function selectZone(zoneId: string) {
    if (activeField === "dropoff") {
      setDropoffZoneId(zoneId);
      setActiveField(pickupZoneId ? null : "pickup");
    } else {
      setPickupZoneId(zoneId);
      setActiveField(dropoffZoneId ? null : "dropoff");
    }
    setSearch("");
  }

  async function handleUseMyLocation() {
    const coords = await requestLocation();
    if (!coords) {
      Alert.alert(
        "Location unavailable",
        "We couldn't get your location. Pick your pickup spot from the list instead.",
      );
      return;
    }
    if (zoneList.length === 0) return;
    const zone = nearestZone(coords.latitude, coords.longitude, zoneList);
    if (zone) {
      setPickupZoneId(zone.id);
      setActiveField(dropoffZoneId ? null : "dropoff");
    }
  }

  function handleSwap() {
    setPickupZoneId(dropoffZoneId);
    setDropoffZoneId(pickupZoneId);
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
        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveField("pickup")}
          style={[styles.fieldRow, activeField === "pickup" && styles.fieldRowActive]}
        >
          <View style={styles.markerCol}>
            <View style={styles.pickupDot} />
            <View style={styles.connector} />
          </View>
          <View style={styles.fieldTextCol}>
            <Text variant="label" style={styles.fieldLabel}>
              PICKUP
            </Text>
            <Text variant="bodyMedium" color="inverse" numberOfLines={1}>
              {pickupZone?.name ?? "Tap to select"}
            </Text>
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveField("dropoff")}
          style={[styles.fieldRow, activeField === "dropoff" && styles.fieldRowActive]}
        >
          <View style={styles.markerCol}>
            <Ionicons name="location" size={16} color={colors.white} />
          </View>
          <View style={styles.fieldTextCol}>
            <Text variant="label" style={styles.fieldLabel}>
              DROPOFF
            </Text>
            <Text variant="bodyMedium" color="inverse" numberOfLines={1}>
              {dropoffZone?.name ?? "Tap to select"}
            </Text>
          </View>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Swap pickup and dropoff"
          onPress={handleSwap}
          style={styles.swapButton}
        >
          <Ionicons name="swap-vertical" size={20} color={colors.white} />
        </Pressable>
      </Card>

      <View style={styles.useLocationButton}>
        <Button
          label="Use my current location"
          variant="secondary"
          onPress={() => void handleUseMyLocation()}
          loading={locationStatus === "loading"}
        />
      </View>

      {activeField ? (
        <View style={styles.pickerSection}>
          <Text variant="label" color="muted" style={styles.pickerLabel}>
            {activeField === "pickup" ? "SELECT PICKUP" : "SELECT DROPOFF"}
          </Text>
          <Input
            placeholder="Search zones"
            value={search}
            onChangeText={setSearch}
            autoCorrect={false}
          />
          <View style={styles.zoneList}>
            {filteredZones.map((zone) => {
              const isSelected = zone.id === pickupZoneId || zone.id === dropoffZoneId;
              return (
                <Pressable key={zone.id} accessibilityRole="button" onPress={() => selectZone(zone.id)}>
                  <Card noPadding style={styles.zoneRow}>
                    <View>
                      <Text variant="bodyMedium">{zone.name}</Text>
                      <Text variant="caption" color="muted">
                        {zone.quadrant}
                      </Text>
                    </View>
                    {isSelected ? <Badge label="Selected" variant="success" /> : null}
                  </Card>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <View style={styles.continueButton}>
        <Button label="Continue" onPress={handleContinue} disabled={!canContinue} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subtitle: { marginTop: spacing.xs, marginBottom: spacing.lg },
  planCard: { gap: 0, position: "relative" },
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
    paddingRight: 44,
  },
  fieldLabel: {
    color: "rgba(255,255,255,0.5)",
  },
  swapButton: {
    position: "absolute",
    right: spacing.sm,
    top: "50%",
    marginTop: -18,
    width: 36,
    height: 36,
    borderRadius: radii.full,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  useLocationButton: { marginTop: spacing.lg },
  pickerSection: { marginTop: spacing.lg },
  pickerLabel: { marginBottom: spacing.sm, letterSpacing: 1 },
  zoneList: { gap: spacing.sm },
  zoneRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  continueButton: { marginTop: spacing.xl, marginBottom: spacing.xl },
  errorContent: { flex: 1, justifyContent: "center", gap: spacing.lg },
  errorBody: { marginBottom: spacing.md },
});
