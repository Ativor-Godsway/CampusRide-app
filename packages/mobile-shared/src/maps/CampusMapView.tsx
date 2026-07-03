import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, {
  AnimatedRegion,
  Marker,
  MarkerAnimated,
  Polyline,
  PROVIDER_DEFAULT,
  type MapStyleElement,
  type Region,
} from "react-native-maps";
import { colors, radii, shadows } from "../design/tokens";
import type { LatLng } from "./projection";

export interface CampusMapZone extends LatLng {
  id: string;
  label: string;
  /** "pickup" | "dropoff" | "driver" — controls the custom marker rendered. */
  role?: "pickup" | "dropoff" | "driver";
}

export interface CampusMapViewProps {
  initialRegion: Region;
  zones: CampusMapZone[];
  onZonePress?: (id: string) => void;
  userLocation?: LatLng | null;
  height: number;
  /** Draws a straight line between these points (e.g. pickup -> dropoff). No routing API — just connects the coordinates directly. */
  routeLine?: LatLng[];
  /** Forces a light map appearance regardless of device theme (iOS Apple Maps). */
  light?: boolean;
  /**
   * Google-provider (Android) custom style JSON. Ignored by Apple Maps on
   * iOS — a true iOS restyle needs PROVIDER_GOOGLE via a dev build (deferred,
   * not Expo Go compatible). iOS instead gets POI/traffic/building muting.
   */
  mapStyle?: MapStyleElement[];
  /** Shows a floating "recenter on route" button that re-frames the map to `initialRegion`. */
  showRecenter?: boolean;
  /** Rounded corners — set false for a full-bleed map. Defaults to true. */
  rounded?: boolean;
}

/**
 * Delays clearing `tracksViewChanges` so a custom marker child paints once
 * before the native side stops re-snapshotting it (setting it false too
 * early leaves the marker blank on Android). Static markers never need it
 * again after the first paint.
 */
function useTracksOnce(delay = 800): boolean {
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setTracks(false), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return tracks;
}

/** Solid near-black dot with a white center — the pickup point. */
function PickupMarker({ zone, onPress }: { zone: CampusMapZone; onPress?: () => void }) {
  const tracks = useTracksOnce();
  return (
    <Marker
      coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
      title={zone.label}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracks}
      onPress={onPress}
      accessibilityLabel={`Pickup: ${zone.label}`}
    >
      <View style={styles.pickupOuter}>
        <View style={styles.pickupInner} />
      </View>
    </Marker>
  );
}

/** Brand-green teardrop pin — the destination. */
function DestinationMarker({ zone, onPress }: { zone: CampusMapZone; onPress?: () => void }) {
  const tracks = useTracksOnce();
  return (
    <Marker
      coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
      title={zone.label}
      anchor={{ x: 0.5, y: 1 }}
      tracksViewChanges={tracks}
      onPress={onPress}
      accessibilityLabel={`Destination: ${zone.label}`}
    >
      <Ionicons name="location" size={34} color={colors.primary[500]} />
    </Marker>
  );
}

/** Car glyph in a rounded near-black tile — smoothly interpolated as location pings arrive. */
function DriverMarker({ zone }: { zone: CampusMapZone }) {
  const tracks = useTracksOnce();
  const region = useRef(
    new AnimatedRegion({
      latitude: zone.latitude,
      longitude: zone.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  ).current;

  useEffect(() => {
    // Native-driven glide between successive pings (~every couple seconds).
    // Reads the existing location stream only — no new subscription.
    // AnimatedRegion.timing animates the region fields directly; the library
    // types spuriously require Animated's `toValue`, so the config is cast.
    const config = {
      latitude: zone.latitude,
      longitude: zone.longitude,
      latitudeDelta: 0,
      longitudeDelta: 0,
      duration: 500,
      useNativeDriver: false,
    } as unknown as Parameters<typeof region.timing>[0];
    region.timing(config).start();
  }, [zone.latitude, zone.longitude, region]);

  return (
    <MarkerAnimated
      coordinate={region as unknown as LatLng}
      anchor={{ x: 0.5, y: 0.5 }}
      tracksViewChanges={tracks}
      accessibilityLabel="Your driver"
    >
      <View style={styles.driverTile}>
        <Ionicons name="car" size={18} color={colors.white} />
      </View>
    </MarkerAnimated>
  );
}

/**
 * Real interactive campus map (react-native-maps — Apple Maps on iOS,
 * Google Maps on Android, both Expo Go compatible). Pickup / dropoff /
 * driver render as custom markers; the driver marker glides between pings.
 */
export function CampusMapView({
  initialRegion,
  zones,
  onZonePress,
  userLocation,
  height,
  routeLine,
  light,
  mapStyle,
  showRecenter,
  rounded = true,
}: CampusMapViewProps) {
  const mapRef = useRef<MapView>(null);

  return (
    <View style={[styles.container, { height }, !rounded && styles.unrounded]}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        customMapStyle={mapStyle}
        showsUserLocation={Boolean(userLocation)}
        showsMyLocationButton={false}
        showsPointsOfInterest={false}
        showsBuildings={false}
        showsTraffic={false}
        toolbarEnabled={false}
        userInterfaceStyle={light ? "light" : undefined}
      >
        {zones.map((zone) => {
          const press = onZonePress ? () => onZonePress(zone.id) : undefined;
          if (zone.role === "driver") return <DriverMarker key={zone.id} zone={zone} />;
          if (zone.role === "dropoff") return <DestinationMarker key={zone.id} zone={zone} onPress={press} />;
          return <PickupMarker key={zone.id} zone={zone} onPress={press} />;
        })}

        {routeLine && routeLine.length >= 2 ? (
          <Polyline
            coordinates={routeLine}
            strokeColor={colors.primary[500]}
            strokeWidth={3}
            lineDashPattern={[8, 6]}
          />
        ) : null}
      </MapView>

      {showRecenter ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recenter map on route"
          onPress={() => mapRef.current?.animateToRegion(initialRegion, 300)}
          style={styles.recenterButton}
        >
          <Ionicons name="locate" size={20} color={colors.ink[700]} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
  },
  unrounded: {
    borderRadius: 0,
  },
  pickupOuter: {
    width: 22,
    height: 22,
    borderRadius: radii.full,
    backgroundColor: colors.ink[900],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.white,
    ...shadows.sm,
  },
  pickupInner: {
    width: 7,
    height: 7,
    borderRadius: radii.full,
    backgroundColor: colors.white,
  },
  driverTile: {
    width: 30,
    height: 30,
    borderRadius: radii.sm,
    backgroundColor: colors.ink[900],
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: colors.white,
    ...shadows.md,
  },
  recenterButton: {
    position: "absolute",
    right: 12,
    bottom: 12,
    width: 40,
    height: 40,
    borderRadius: radii.full,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    ...shadows.md,
  },
});
