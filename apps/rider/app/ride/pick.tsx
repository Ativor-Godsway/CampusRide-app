import { useMemo, useState } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Image, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import MapView, { Polygon, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  PLACES_ATTRIBUTION,
  SERVICE_AREA_POLYGON,
  isInServiceArea,
  pinEnd,
  tripEndFromParams,
  tripEndProblem,
} from "@rida/shared";
import { Button, Text, colors, illustrations, radii, shadows, spacing, withAlpha } from "@rida/mobile-shared";
import { usePlaces } from "../../lib/chooseRide";
import { setPickedPin } from "../../lib/planDraft";

/** Roughly the middle of campus, for a picker opened with nothing to start from. */
const CAMPUS_CENTRE = { latitude: 5.6505, longitude: -0.1875 };
const PIN_SIZE = 48;

/**
 * "Choose on map": the map moves under a pin fixed in the middle; where it
 * stops is the pickup or drop-off. Labelled by the nearest campus place
 * ("Near Night Market"). Outside the CampusRide area (the dashed line) the
 * pin can't be set, and the rider is told why.
 *
 * Params: `field` ("pickup" | "dropoff") and, optionally, a start point
 * (tripEndParams with the "pickup" prefix).
 */
export default function PickOnMapScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const params = useLocalSearchParams<Record<string, string>>();
  const field = params.field === "pickup" ? "pickup" : "dropoff";
  const start = tripEndFromParams("pickup", params) ?? CAMPUS_CENTRE;
  const { data: places = [] } = usePlaces();

  const [center, setCenter] = useState({ latitude: start.latitude, longitude: start.longitude });
  const [moving, setMoving] = useState(false);
  const end = useMemo(() => pinEnd(center, places), [center, places]);
  const inside = isInServiceArea(center);
  const area = useMemo(() => SERVICE_AREA_POLYGON.map(([latitude, longitude]) => ({ latitude, longitude })), []);

  const initialRegion: Region = { ...start, latitudeDelta: 0.006, longitudeDelta: 0.006 };

  function confirm() {
    if (!inside) return;
    setPickedPin({ field, end });
    router.back();
  }

  return (
    <View style={styles.root}>
      <MapView
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        showsUserLocation
        showsMyLocationButton={false}
        toolbarEnabled={false}
        userInterfaceStyle="light"
        onRegionChange={() => setMoving(true)}
        onRegionChangeComplete={(r) => {
          setMoving(false);
          setCenter({ latitude: r.latitude, longitude: r.longitude });
        }}
      >
        <Polygon
          coordinates={area}
          strokeColor={colors.primary[500]}
          strokeWidth={2}
          lineDashPattern={[8, 6]}
          fillColor={withAlpha(colors.primary[500], 0.04)}
        />
      </MapView>

      {/* The pin sits over the map's centre; its tip is the point. */}
      <View pointerEvents="none" style={[styles.pinWrap, { top: height / 2 - PIN_SIZE }]}>
        <Image
          source={field === "pickup" ? illustrations.pinPickup : illustrations.pinDropoff}
          style={[styles.pin, moving && styles.pinLifted]}
          resizeMode="contain"
        />
      </View>

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        hitSlop={8}
        style={[styles.back, { top: insets.top + spacing.sm }]}
      >
        <Ionicons name="arrow-back" size={22} color={colors.ink} />
      </Pressable>

      <View style={[styles.card, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <Text variant="label" color="muted">
          {field === "pickup" ? "PICKUP" : "DROP-OFF"}
        </Text>
        <Text variant="h3" numberOfLines={2} accessibilityLiveRegion="polite">
          {moving ? "Move the map to place the pin…" : end.label}
        </Text>
        {!inside && !moving ? (
          <Text variant="bodySmall" style={styles.outside} accessibilityRole="alert">
            {tripEndProblem(end, field)}
          </Text>
        ) : (
          <Text variant="caption" color="muted">
            Drag the map to put the pin exactly where {field === "pickup" ? "you'll be" : "you're going"}.
          </Text>
        )}
        <Button
          label={field === "pickup" ? "Set pickup here" : "Set drop-off here"}
          size="lg"
          disabled={!inside || moving}
          onPress={confirm}
        />
        <Text variant="caption" color="muted" style={styles.attribution}>
          Places {PLACES_ATTRIBUTION}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface2 },
  pinWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  pin: { width: PIN_SIZE, height: PIN_SIZE },
  pinLifted: { transform: [{ translateY: -8 }] },
  back: {
    position: "absolute",
    left: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
  card: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    ...shadows.lg,
  },
  outside: { color: colors.danger },
  attribution: { textAlign: "center" },
});
