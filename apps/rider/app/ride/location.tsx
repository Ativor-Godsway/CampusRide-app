import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { Alert, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import type { Zone } from "@rida/shared";
import { nearestZone } from "@rida/shared";
import {
  Badge,
  Button,
  Card,
  Input,
  LoadingState,
  MapboxStaticMap,
  Screen,
  Text,
  colors,
  getMapboxToken,
  getZones,
  radii,
  spacing,
  useCurrentLocation,
} from "@rida/mobile-shared";

type ActiveField = "pickup" | "dropoff" | null;

const MAP_HEIGHT = 220;

export default function LocationScreen() {
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  const mapboxToken = getMapboxToken();
  const { status: locationStatus, requestLocation } = useCurrentLocation();

  const { data: zones, isLoading, isError } = useQuery<Zone[]>({
    queryKey: ["zones"],
    queryFn: getZones,
  });

  const [pickupZoneId, setPickupZoneId] = useState<string | null>(null);
  const [dropoffZoneId, setDropoffZoneId] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<ActiveField>("pickup");
  const [search, setSearch] = useState("");
  const [userCoords, setUserCoords] = useState<{ latitude: number; longitude: number } | null>(
    null,
  );

  const zoneList: Zone[] = zones ?? [];

  const zoneById = useMemo(() => {
    const map = new Map<string, Zone>();
    for (const zone of zoneList) map.set(zone.id, zone);
    return map;
  }, [zoneList]);

  const pickupZone = pickupZoneId ? zoneById.get(pickupZoneId) ?? null : null;
  const dropoffZone = dropoffZoneId ? zoneById.get(dropoffZoneId) ?? null : null;

  const center = useMemo(() => {
    if (zoneList.length === 0) return null;
    const latitude = zoneList.reduce((sum, z) => sum + z.latitude, 0) / zoneList.length;
    const longitude = zoneList.reduce((sum, z) => sum + z.longitude, 0) / zoneList.length;
    return { latitude, longitude };
  }, [zoneList]);

  const mapWidth = windowWidth - spacing.xl * 2;

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
        "We couldn't get your location. Pick your pickup spot from the map or list instead.",
      );
      return;
    }
    if (zoneList.length === 0) return;
    const zone = nearestZone(coords.latitude, coords.longitude, zoneList);
    if (zone) {
      setUserCoords(coords);
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

  if (isError || !zones || !center) {
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

  const markers = zoneList.map((zone) => ({
    id: zone.id,
    latitude: zone.latitude,
    longitude: zone.longitude,
    label: zone.name,
    selected: zone.id === pickupZoneId || zone.id === dropoffZoneId,
  }));

  return (
    <Screen scroll>
      <Text variant="h1">Plan your ride</Text>
      <Text variant="bodySmall" color="muted" style={styles.subtitle}>
        Choose where you're starting and where you're headed.
      </Text>

      {mapboxToken ? (
        <View style={styles.mapWrapper}>
          <MapboxStaticMap
            accessToken={mapboxToken}
            center={center}
            width={mapWidth}
            height={MAP_HEIGHT}
            markers={markers}
            userLocation={userCoords}
            onMarkerPress={selectZone}
          />
        </View>
      ) : (
        <Card style={styles.mapFallback}>
          <Text variant="bodySmall" color="muted">
            Map preview unavailable — set EXPO_PUBLIC_MAPBOX_TOKEN to enable it. Use the list
            below to choose zones.
          </Text>
        </Card>
      )}

      <View style={styles.fieldsRow}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveField("pickup")}
          style={styles.fieldPressable}
        >
          <Card style={[styles.fieldCard, activeField === "pickup" && styles.fieldCardActive]}>
            <Text variant="label" color="muted">
              PICKUP
            </Text>
            <Text variant="bodyMedium" numberOfLines={1}>
              {pickupZone?.name ?? "Tap to select"}
            </Text>
          </Card>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Swap pickup and dropoff"
          onPress={handleSwap}
          style={styles.swapButton}
        >
          <Text variant="h3">⇄</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={() => setActiveField("dropoff")}
          style={styles.fieldPressable}
        >
          <Card style={[styles.fieldCard, activeField === "dropoff" && styles.fieldCardActive]}>
            <Text variant="label" color="muted">
              DROPOFF
            </Text>
            <Text variant="bodyMedium" numberOfLines={1}>
              {dropoffZone?.name ?? "Tap to select"}
            </Text>
          </Card>
        </Pressable>
      </View>

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
  mapWrapper: { marginBottom: spacing.lg },
  mapFallback: { marginBottom: spacing.lg, backgroundColor: colors.surface },
  fieldsRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  fieldPressable: { flex: 1 },
  fieldCard: { gap: 2 },
  fieldCardActive: { borderColor: colors.primary[500] },
  swapButton: {
    width: 40,
    height: 40,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  useLocationButton: { marginTop: spacing.md },
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
