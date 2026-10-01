import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { Ionicons } from "@expo/vector-icons";
import type { LatLng } from "@rida/shared";
import { Text, colors, radii, shadows, spacing, typography } from "@rida/mobile-shared";

/** A stop shown on the map; `isNew` marks a previewed rider's pickup or drop-off. */
export interface MapStop {
  key: string;
  kind: "PICKUP" | "DROPOFF";
  riderFirstName: string;
  zone: { name: string; latitude: number; longitude: number };
  isNew?: boolean;
}

export interface TripPreviewOverlay {
  /** Every stop in the proposed order (new ones marked isNew). */
  stops: readonly MapStop[];
  /** The proposed route, already trimmed to the driver's position. */
  path: readonly LatLng[];
  /** "Add" was tapped: the dotted line turns solid before the trip takes it over. */
  committing: boolean;
}

export interface TripMapProps {
  driver: LatLng | null;
  /** Upcoming stops in order; numbered 1, 2, 3… on the map. */
  stops: readonly MapStop[];
  /** The route to draw (driver → stop 1 → stop 2 …). */
  path: readonly LatLng[];
  /** Map area hidden behind the top bar and the bottom card. */
  insets: { top: number; bottom: number };
  /** Credit for stored road routes, when any are drawn (required by the routing provider). */
  attribution?: string | null;
  /** A rider being considered: their route dotted, their pins marked "New". */
  preview?: TripPreviewOverlay | null;
}

/**
 * Full-screen trip map: the driver, every remaining stop numbered in order
 * (green = pickup, black = drop-off, as in the stop list), and the route.
 * Re-frames itself when the stops change; the "recenter" control sits just
 * above the bottom card so it can never be clipped by it.
 */
export function TripMap({ driver, stops, path, insets, attribution, preview }: TripMapProps) {
  const mapRef = useRef<MapView>(null);
  const [ready, setReady] = useState(false);

  // While previewing, the pins show the proposed order (new ones marked).
  const shownStops = preview ? preview.stops : stops;

  const fit = useCallback(() => {
    const points: LatLng[] = [
      ...(driver ? [driver] : []),
      ...shownStops.map((s) => ({ latitude: s.zone.latitude, longitude: s.zone.longitude })),
    ];
    if (points.length === 0) return;
    mapRef.current?.fitToCoordinates(points, {
      edgePadding: { top: insets.top + 40, bottom: insets.bottom + 40, left: 48, right: 48 },
      animated: true,
    });
  }, [driver, shownStops, insets.top, insets.bottom]);

  // Re-frame when the set of stops changes — including a preview opening or
  // closing, so new stops are always in view — but not on every GPS tick.
  const stopsKey = shownStops.map((s) => s.key).join(",");
  useEffect(() => {
    if (ready) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on stop changes only
  }, [ready, stopsKey, insets.top, insets.bottom]);

  const first = stops[0]?.zone ?? driver;

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={
          first
            ? { latitude: first.latitude, longitude: first.longitude, latitudeDelta: 0.012, longitudeDelta: 0.012 }
            : undefined
        }
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsCompass={false}
        toolbarEnabled={false}
        userInterfaceStyle="light"
        mapPadding={{ top: insets.top, bottom: insets.bottom, left: 0, right: 0 }}
        onMapReady={() => setReady(true)}
      >
        {/* Stable keys: a new route only changes a line's points, so the map
            never redraws (no flicker). */}
        {path.length >= 2 && !preview?.committing ? (
          <Polyline
            key="route-main"
            coordinates={path as LatLng[]}
            strokeColor={colors.primary[500]}
            strokeWidth={5}
            lineJoin="round"
            zIndex={1}
          />
        ) : null}
        {preview && preview.path.length >= 2 ? (
          <Polyline
            // iOS doesn't restyle a dash pattern in place; a new key swaps just this line.
            key={preview.committing ? "route-preview-solid" : "route-preview"}
            coordinates={preview.path as LatLng[]}
            strokeColor={preview.committing ? colors.primary[500] : colors.primary[300]}
            strokeWidth={preview.committing ? 5 : 4}
            lineDashPattern={preview.committing ? undefined : [2, 9]}
            lineCap="round"
            lineJoin="round"
            zIndex={preview.committing ? 2 : 0}
          />
        ) : null}

        {shownStops.map((stop, i) => (
          <Marker
            key={stop.key}
            anchor={{ x: 0.5, y: stop.isNew ? 0.78 : 0.5 }}
            coordinate={{ latitude: stop.zone.latitude, longitude: stop.zone.longitude }}
            title={`${stop.kind === "PICKUP" ? "Pick up" : "Drop off"} ${stop.riderFirstName}`}
            description={stop.zone.name}
            zIndex={stops.length - i}
          >
            <View style={styles.pinColumn}>
              {stop.isNew ? (
                <View style={styles.newTag}>
                  <Text variant="caption" style={styles.newTagText}>
                    New
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.stopPin,
                  stop.kind === "PICKUP" ? styles.pickupPin : styles.dropoffPin,
                  stop.isNew && styles.newPin,
                  i === 0 && styles.nextPin,
                ]}
              >
                <Text variant="caption" style={[styles.stopNumber, stop.isNew && styles.newPinNumber]}>
                  {i + 1}
                </Text>
              </View>
            </View>
          </Marker>
        ))}

        {driver ? (
          <Marker coordinate={driver} anchor={{ x: 0.5, y: 0.5 }} zIndex={100} title="You">
            <View style={styles.driverOuter}>
              <View style={styles.driverInner} />
            </View>
          </Marker>
        ) : null}
      </MapView>

      {attribution ? (
        <View pointerEvents="none" style={[styles.attribution, { bottom: insets.bottom + 2 }]}>
          <Text style={styles.attributionText}>{attribution}</Text>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show the whole route"
        onPress={fit}
        hitSlop={6}
        style={[styles.recenter, { bottom: insets.bottom + spacing.md }]}
      >
        <Ionicons name="scan-outline" size={20} color={colors.ink[700]} />
      </Pressable>
    </View>
  );
}

const PIN = 30;

const styles = StyleSheet.create({
  attribution: {
    position: "absolute",
    left: 6,
    backgroundColor: "rgba(255,255,255,0.8)",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  attributionText: { fontSize: 9, color: colors.ink[600] },
  stopPin: {
    width: PIN,
    height: PIN,
    borderRadius: PIN / 2,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.white,
    ...shadows.md,
  },
  pickupPin: { backgroundColor: colors.primary[500] },
  dropoffPin: { backgroundColor: colors.ink[900] },
  nextPin: { transform: [{ scale: 1.2 }] },
  pinColumn: { alignItems: "center" },
  newPin: { backgroundColor: colors.white, borderColor: colors.primary[300], borderStyle: "dashed" },
  newPinNumber: { color: colors.primary[600] },
  newTag: {
    backgroundColor: colors.accent[500],
    borderRadius: radii.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginBottom: 2,
  },
  newTagText: { color: colors.white, fontWeight: typography.weight.extrabold, fontSize: 10 },
  stopNumber: { color: colors.white, fontWeight: typography.weight.extrabold },
  driverOuter: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
  driverInner: { width: 16, height: 16, borderRadius: 8, backgroundColor: colors.accent[500] },
  recenter: {
    position: "absolute",
    right: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
});
