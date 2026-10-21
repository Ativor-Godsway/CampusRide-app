import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "react-native-maps";
import { haversineDistanceMeters, type LatLng } from "@rida/shared";
import {
  CarMarker,
  IconButton,
  Text,
  colors,
  radii,
  shadows,
  spacing,
  withAlpha,
} from "@rida/mobile-shared";

/** A stop shown on the map. */
export interface MapStop {
  key: string;
  kind: "PICKUP" | "DROPOFF";
  riderFirstName: string;
  zone: { name: string; latitude: number; longitude: number };
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
}

/**
 * Splits the route where it reaches the next stop: the leg to drive now,
 * and everything after it.
 */
function splitAtNextStop(
  path: readonly LatLng[],
  next: LatLng | undefined,
): { now: LatLng[]; later: LatLng[] } {
  if (!next || path.length < 2) return { now: [...path], later: [] };
  let best = path.length - 1;
  let bestDistance = Infinity;
  path.forEach((p, i) => {
    const d = haversineDistanceMeters(p, next);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return { now: path.slice(0, best + 1), later: path.slice(best) };
}

/**
 * Full-screen trip map (docs/mockups/11-driver-trip.png): the driver's car
 * (top-down, turned to its heading), every remaining stop numbered in order
 * — green circles for pickups, ink rounded squares for drop-offs, as in the
 * stop list — and the route: the leg to the next stop bold green, later legs
 * faint. Re-frames itself when the stops change; "Show the whole route"
 * sits bottom-right, just above the card.
 */
export function TripMap({ driver, stops, path, insets, attribution }: TripMapProps) {
  const mapRef = useRef<MapView>(null);
  const [ready, setReady] = useState(false);

  const fit = useCallback(() => {
    const points: LatLng[] = [
      ...(driver ? [driver] : []),
      ...stops.map((s) => ({ latitude: s.zone.latitude, longitude: s.zone.longitude })),
    ];
    if (points.length === 0) return;
    mapRef.current?.fitToCoordinates(points, {
      edgePadding: { top: insets.top + 40, bottom: insets.bottom + 40, left: 48, right: 48 },
      animated: true,
    });
  }, [driver, stops, insets.top, insets.bottom]);

  // Re-frame when the set of stops changes, not on every GPS tick.
  const stopsKey = stops.map((s) => s.key).join(",");
  useEffect(() => {
    if (ready) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit on stop changes only
  }, [ready, stopsKey, insets.top, insets.bottom]);

  const next = stops[0]?.zone;
  const legs = useMemo(
    () =>
      splitAtNextStop(
        path,
        next ? { latitude: next.latitude, longitude: next.longitude } : undefined,
      ),
    [path, next],
  );
  const first = next ?? driver;

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={
          first
            ? {
                latitude: first.latitude,
                longitude: first.longitude,
                latitudeDelta: 0.012,
                longitudeDelta: 0.012,
              }
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
            never redraws (no flicker). Later legs first, so the leg to drive
            now is drawn on top where they meet. */}
        {legs.later.length >= 2 ? (
          <Polyline
            key="route-later"
            coordinates={legs.later}
            strokeColor={withAlpha(colors.green500, 0.35)}
            strokeWidth={5}
            lineJoin="round"
            zIndex={1}
          />
        ) : null}
        {legs.now.length >= 2 ? (
          <Polyline
            key="route-now"
            coordinates={legs.now}
            strokeColor={colors.green500}
            strokeWidth={6}
            lineJoin="round"
            zIndex={2}
          />
        ) : null}

        {stops.map((stop, i) => (
          <Marker
            key={stop.key}
            anchor={{ x: 0.5, y: 0.5 }}
            coordinate={{ latitude: stop.zone.latitude, longitude: stop.zone.longitude }}
            title={`${stop.kind === "PICKUP" ? "Pick up" : "Drop off"} ${stop.riderFirstName}`}
            description={stop.zone.name}
            zIndex={stops.length - i + 2}
          >
            <StopMarker kind={stop.kind} number={i + 1} />
          </Marker>
        ))}

        {driver ? (
          <CarMarker zone={{ id: "car", ...driver, label: "You", role: "driver" }} />
        ) : null}
      </MapView>

      {attribution ? (
        <View pointerEvents="none" style={[styles.attribution, { bottom: insets.bottom + 2 }]}>
          <Text style={styles.attributionText}>{attribution}</Text>
        </View>
      ) : null}

      <View style={[styles.fit, { bottom: insets.bottom + spacing[3] }]}>
        <IconButton
          variant="map"
          icon="scan-outline"
          accessibilityLabel="Show the whole route"
          onPress={fit}
        />
      </View>
    </View>
  );
}

/** A numbered stop: a green circle for a pickup, an ink rounded square for a drop-off, white 3px border. */
export function StopMarker({
  kind,
  number,
  size = 32,
}: {
  kind: "PICKUP" | "DROPOFF";
  number: number;
  size?: number;
}) {
  return (
    <View
      style={[
        styles.stop,
        { width: size, height: size },
        kind === "PICKUP"
          ? { borderRadius: size / 2, backgroundColor: colors.green500 }
          : { borderRadius: radii.sm, backgroundColor: colors.ink },
      ]}
    >
      <Text variant="subhead" color="onDark" style={styles.stopNumber} tabular>
        {number}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  attribution: {
    position: "absolute",
    left: 6,
    backgroundColor: "rgba(255,255,255,0.8)",
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  attributionText: { fontSize: 9, color: colors.ink2 },
  stop: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.surface,
    ...shadows.float,
  },
  stopNumber: { fontWeight: "800" },
  fit: { position: "absolute", right: spacing.gutter },
});
