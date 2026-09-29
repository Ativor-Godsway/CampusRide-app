import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import type { EdgePadding } from "@rida/shared";
import { useReduceMotion } from "../design/components/Illustration";
import { colors, radii, shadows, withAlpha } from "../design/tokens";
import { illustrations } from "../design/illustrations";
import type { LatLng } from "./projection";

export interface CampusMapZone extends LatLng {
  id: string;
  label: string;
  /**
   * "pickup" | "dropoff" draw the 3D pins; "driver" draws the 3D top-down car
   * that turns to face the direction it's moving. undefined = plain pin.
   */
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
  /** Shows a floating "recenter on route" button that re-frames the map to `initialRegion`. */
  showRecenter?: boolean;
  /** Rounded corners — set false for a full-bleed map. Defaults to true. */
  rounded?: boolean;
  /**
   * Id of a zone to draw a soft, expanding pulse around (e.g. the pickup
   * while searching for a driver). Skipped when Reduce Motion is on.
   */
  pulseZoneId?: string;
  /**
   * Keep these points (e.g. pickup + drop-off) in view: the map fits to them
   * once it's ready and again whenever they or `fitPadding` change — so a
   * screen re-fits when its bottom sheet changes height. Replaces
   * `initialRegion` as what "recenter" returns to.
   */
  fitTo?: LatLng[];
  /** Points of map covered by overlays (pill, sheet) plus margin; see mapFitPadding. */
  fitPadding?: EdgePadding;
  /** Lifts the recenter button above a bottom sheet covering this many points. */
  controlsBottomInset?: number;
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
  pulseZoneId,
  fitTo,
  fitPadding,
  controlsBottomInset = 0,
}: CampusMapViewProps) {
  const mapRef = useRef<MapView>(null);
  const reduceMotion = useReduceMotion();
  const [mapReady, setMapReady] = useState(false);
  const pulseZone = pulseZoneId ? zones.find((z) => z.id === pulseZoneId) : undefined;

  // Stable key: re-fit only when the points or padding really change, not on
  // every render that builds a new (equal) array.
  const fitKey = fitTo?.length
    ? JSON.stringify([fitTo.map((p) => [p.latitude.toFixed(6), p.longitude.toFixed(6)]), fitPadding ?? null])
    : null;
  const fitRef = useRef({ fitTo, fitPadding });
  fitRef.current = { fitTo, fitPadding };

  const fit = useCallback((animated: boolean) => {
    const { fitTo: points, fitPadding: padding } = fitRef.current;
    if (!points?.length) return false;
    mapRef.current?.fitToCoordinates(points, { edgePadding: padding, animated });
    return true;
  }, []);

  useEffect(() => {
    if (mapReady && fitKey) fit(!reduceMotion);
  }, [mapReady, fitKey, fit, reduceMotion]);

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
        onMapReady={() => setMapReady(true)}
      >
        {pulseZone ? <ZonePulse center={pulseZone} /> : null}

        {zones.map((zone) =>
          zone.role ? (
            <ArtMarker key={zone.id} zone={zone} onPress={() => onZonePress?.(zone.id)} />
          ) : (
            <Marker
              key={zone.id}
              coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
              title={zone.label}
              pinColor={colors.accent[500]}
              onPress={() => onZonePress?.(zone.id)}
            />
          ),
        )}

        {routeLine && routeLine.length >= 2 ? (
          <Polyline coordinates={routeLine} strokeColor={colors.primary[500]} strokeWidth={3} lineDashPattern={[8, 6]} />
        ) : null}
      </MapView>

      {showRecenter ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Recenter map on route"
          onPress={() => {
            if (!fit(!reduceMotion)) mapRef.current?.animateToRegion(initialRegion, 300);
          }}
          style={[styles.recenterButton, { bottom: 12 + controlsBottomInset }]}
        >
          <Ionicons name="locate" size={20} color={colors.ink[700]} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Compass bearing in degrees (0 = north) from `a` to `b`. */
function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLon = toRad(b.longitude - a.longitude);
  const y = Math.sin(dLon) * Math.cos(toRad(b.latitude));
  const x =
    Math.cos(toRad(a.latitude)) * Math.sin(toRad(b.latitude)) -
    Math.sin(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const PIN_SIZE = 46;
const CAR_SIZE = 52;

/**
 * Map marker drawn with the 3D artwork. The driver car rotates to face its
 * direction of travel (worked out from its last two positions). Markers stop
 * re-rendering once the image has loaded, which keeps Android smooth.
 */
function ArtMarker({ zone, onPress }: { zone: CampusMapZone; onPress: () => void }) {
  const isCar = zone.role === "driver";
  const [ready, setReady] = useState(false);
  const [heading, setHeading] = useState(0);
  const last = useRef<LatLng | null>(null);

  useEffect(() => {
    if (!isCar) return;
    const prev = last.current;
    const next = { latitude: zone.latitude, longitude: zone.longitude };
    // Ignore GPS jitter under ~3 m so the car doesn't spin while parked.
    if (prev && Math.abs(prev.latitude - next.latitude) + Math.abs(prev.longitude - next.longitude) > 0.00003) {
      setHeading(bearingBetween(prev, next));
    }
    last.current = next;
  }, [isCar, zone.latitude, zone.longitude]);

  const source =
    zone.role === "driver"
      ? illustrations.carTopdown
      : zone.role === "dropoff"
        ? illustrations.pinDropoff
        : illustrations.pinPickup;
  const size = isCar ? CAR_SIZE : PIN_SIZE;

  return (
    <Marker
      coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
      title={zone.label}
      onPress={onPress}
      anchor={isCar ? { x: 0.5, y: 0.5 } : { x: 0.5, y: 0.94 }}
      rotation={isCar ? heading : 0}
      flat={isCar}
      tracksViewChanges={!ready}
      zIndex={isCar ? 3 : 2}
    >
      <Image source={source} style={{ width: size, height: size }} resizeMode="contain" onLoad={() => setReady(true)} />
    </Marker>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Largest radius of the pickup pulse, in metres on the ground. */
const PULSE_MAX_RADIUS_M = 70;

/**
 * A soft ring that grows out from a map point and fades, on a loop. Drawn as
 * a native map Circle (radius in metres) rather than an animated marker
 * view: a custom Marker only animates on Android with tracksViewChanges on,
 * which re-rasterizes the marker every frame.
 */
function ZonePulse({ center }: { center: LatLng }) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    // Circle props aren't native-driver capable, so this runs on JS — but it
    // is one small value, and only while this screen shows it.
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 2200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion]);

  if (reduceMotion) return null;

  return (
    <AnimatedCircle
      center={{ latitude: center.latitude, longitude: center.longitude }}
      radius={progress.interpolate({ inputRange: [0, 1], outputRange: [8, PULSE_MAX_RADIUS_M] })}
      fillColor={progress.interpolate({
        inputRange: [0, 1],
        outputRange: [withAlpha(colors.primary[500], 0.28), withAlpha(colors.primary[500], 0)],
      })}
      strokeColor={progress.interpolate({
        inputRange: [0, 1],
        outputRange: [withAlpha(colors.primary[500], 0.55), withAlpha(colors.primary[500], 0)],
      })}
      strokeWidth={1.5}
      zIndex={1}
    />
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
