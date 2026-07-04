import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import { colors, radii, shadows } from "../design/tokens";
import type { LatLng } from "./projection";

export interface CampusMapZone extends LatLng {
  id: string;
  label: string;
  /** "pickup" | "dropoff" | undefined — controls pin color/role. */
  role?: "pickup" | "dropoff";
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
  /** Shows a floating "recenter on route" button that re-frames the map to `initialRegion`. */
  showRecenter?: boolean;
  /** Rounded corners — set false for a full-bleed map. Defaults to true. */
  rounded?: boolean;
}

/**
 * Real interactive campus map (react-native-maps — Apple Maps on iOS,
 * Google Maps on Android, both Expo Go compatible). Renders one Marker per
 * campus zone; pickup/dropoff selections are color-coded.
 */
export function CampusMapView({
  initialRegion,
  zones,
  onZonePress,
  userLocation,
  height,
  routeLine,
  light,
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
        showsUserLocation={Boolean(userLocation)}
        showsMyLocationButton={false}
        toolbarEnabled={false}
        userInterfaceStyle={light ? "light" : undefined}
      >
        {zones.map((zone) => (
          <Marker
            key={zone.id}
            coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
            title={zone.label}
            pinColor={
              zone.role === "pickup"
                ? colors.primary[500]
                : zone.role === "dropoff"
                  ? colors.ink[900]
                  : colors.accent[500]
            }
            onPress={() => onZonePress?.(zone.id)}
          />
        ))}

        {routeLine && routeLine.length >= 2 ? (
          <Polyline coordinates={routeLine} strokeColor={colors.primary[500]} strokeWidth={3} lineDashPattern={[8, 6]} />
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
