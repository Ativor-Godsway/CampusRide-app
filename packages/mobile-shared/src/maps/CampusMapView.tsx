import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, StyleSheet, Text, View } from "react-native";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import type { EdgePadding } from "@rida/shared";
import { useReduceMotion } from "../design/components/Illustration";
import { colors, radii, spacing, withAlpha } from "../design/tokens";
import { IconButton } from "../design/components/IconButton";
import { PULSE_MS } from "../design/components/PulseRings";
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
  /** Bump to re-place a marker the rider dragged (a drag moves the native marker, not the prop). */
  version?: number;
}

export interface CampusMapViewProps {
  initialRegion: Region;
  zones: CampusMapZone[];
  onZonePress?: (id: string) => void;
  userLocation?: LatLng | null;
  height: number;
  /** Draws a line through these points (e.g. pickup -> dropoff). */
  routeLine?: LatLng[];
  /**
   * True when routeLine follows real roads (a precomputed zone route): drawn
   * solid. Otherwise it is a straight-line stand-in and drawn dashed.
   */
  routeIsRoad?: boolean;
  /**
   * The way to the start of the route (e.g. the driver's car to a pickup on
   * a ride offer): a dashed ink line, drawn under the route.
   */
  approachLine?: LatLng[];
  /** Credit line for the road route's data, shown small in a corner (required by the routing provider). */
  routeAttribution?: string;
  /** Forces a light map appearance regardless of device theme (iOS Apple Maps). */
  light?: boolean;
  /** Shows a floating "recenter on route" button that re-frames the map to `initialRegion`. */
  showRecenter?: boolean;
  /** What the recentre button says to screen readers (default: on the route). */
  recenterLabel?: string;
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
  /** Id of a zone the rider may drag ("Move pin to the exact spot"); reported through onZoneDragEnd. */
  draggableZoneId?: string;
  onZoneDragEnd?: (id: string, point: LatLng) => void;
  /** A soft circle on the map, e.g. how far a pin may be moved. */
  circle?: { center: LatLng; radiusMeters: number } | null;
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
  routeIsRoad = false,
  approachLine,
  routeAttribution,
  light,
  showRecenter,
  recenterLabel = "Recentre the map on the route",
  rounded = true,
  pulseZoneId,
  fitTo,
  fitPadding,
  controlsBottomInset = 0,
  draggableZoneId,
  onZoneDragEnd,
  circle,
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

        {circle ? (
          <Circle
            center={circle.center}
            radius={circle.radiusMeters}
            fillColor={withAlpha(colors.primary[500], 0.08)}
            strokeColor={withAlpha(colors.primary[500], 0.5)}
            strokeWidth={1.5}
            zIndex={1}
          />
        ) : null}

        {/* Every marker is a 3D render (docs/design-system.md, Iconography): a
            place without a role gets the drop-off pin. */}
        {zones.map((zone) =>
          zone.role === "driver" ? (
            <CarMarker
              key={`${zone.id}:${zone.version ?? 0}`}
              zone={zone}
              onPress={() => onZonePress?.(zone.id)}
            />
          ) : (
            <ArtMarker
              key={`${zone.id}:${zone.version ?? 0}`}
              zone={zone}
              onPress={() => onZonePress?.(zone.id)}
              draggable={zone.id === draggableZoneId}
              onDragEnd={(point) => onZoneDragEnd?.(zone.id, point)}
            />
          ),
        )}

        {approachLine && approachLine.length >= 2 ? (
          <Polyline
            coordinates={approachLine}
            strokeColor={colors.ink2}
            strokeWidth={3}
            lineDashPattern={[4, 6]}
          />
        ) : null}

        {routeLine && routeLine.length >= 2 ? (
          <Polyline
            coordinates={routeLine}
            strokeColor={colors.mapRoute}
            strokeWidth={5}
            lineDashPattern={routeIsRoad ? undefined : [8, 6]}
          />
        ) : null}
      </MapView>

      {routeIsRoad && routeAttribution ? (
        <View pointerEvents="none" style={[styles.attribution, { bottom: 4 + controlsBottomInset }]}>
          <Text style={styles.attributionText}>{routeAttribution}</Text>
        </View>
      ) : null}

      {showRecenter ? (
        // The spec's 44px floating map button, just above whatever covers the map's bottom.
        <View style={[styles.recenterButton, { bottom: spacing[3] + controlsBottomInset }]}>
          <IconButton
            variant="map"
            icon="locate"
            accessibilityLabel={recenterLabel}
            onPress={() => {
              if (!fit(!reduceMotion)) mapRef.current?.animateToRegion(initialRegion, 300);
            }}
          />
        </View>
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

/** The 3D pins at 44pt, tip on the point (anchor y 0.94). */
const PIN_SIZE = 44;
/** The top-down car, about a pin's size. */
const CAR_SIZE = 44;
/**
 * How long the car takes to glide to a new GPS fix. Drivers report about
 * every 5 s; a short glide keeps the car close to where it really is while
 * hiding the jump.
 */
const GLIDE_MS = 1000;

/** Map marker drawn with a 3D pin. Stops re-rendering once the image has loaded, which keeps Android smooth. */
function ArtMarker({
  zone,
  onPress,
  draggable = false,
  onDragEnd,
}: {
  zone: CampusMapZone;
  onPress: () => void;
  draggable?: boolean;
  onDragEnd?: (point: LatLng) => void;
}) {
  const [ready, setReady] = useState(false);
  const source = zone.role === "dropoff" ? illustrations.pinDropoff : illustrations.pinPickup;
  return (
    <Marker
      coordinate={{ latitude: zone.latitude, longitude: zone.longitude }}
      title={zone.label}
      onPress={onPress}
      anchor={{ x: 0.5, y: 0.94 }}
      draggable={draggable}
      onDragEnd={(e) => onDragEnd?.(e.nativeEvent.coordinate)}
      tracksViewChanges={!ready}
      zIndex={2}
    >
      <Image
        source={source}
        style={{ width: PIN_SIZE, height: PIN_SIZE }}
        resizeMode="contain"
        onLoad={() => setReady(true)}
      />
    </Marker>
  );
}

/**
 * The driver's top-down car. It turns to face its direction of travel
 * (worked out from its last two positions) and glides to each new GPS fix
 * instead of jumping; with Reduce Motion on it jumps. The glide moves the
 * native marker, so the image itself stops re-rendering once it has loaded.
 * Exported for maps of their own (the driver's trip map); give it a
 * MapView parent.
 */
export function CarMarker({ zone, onPress }: { zone: CampusMapZone; onPress?: () => void }) {
  const reduceMotion = useReduceMotion();
  const [ready, setReady] = useState(false);
  const [heading, setHeading] = useState(0);
  const last = useRef<LatLng | null>(null);
  const latitude = useRef(new Animated.Value(zone.latitude)).current;
  const longitude = useRef(new Animated.Value(zone.longitude)).current;
  const coordinate = useRef({ latitude, longitude }).current;

  useEffect(() => {
    const prev = last.current;
    const next = { latitude: zone.latitude, longitude: zone.longitude };
    last.current = next;
    if (!prev) return;
    // Ignore GPS jitter under ~3 m so the car doesn't spin while parked.
    if (Math.abs(prev.latitude - next.latitude) + Math.abs(prev.longitude - next.longitude) > 0.00003) {
      setHeading(bearingBetween(prev, next));
    }
    latitude.stopAnimation();
    longitude.stopAnimation();
    if (reduceMotion) {
      latitude.setValue(next.latitude);
      longitude.setValue(next.longitude);
      return;
    }
    // Map coordinates aren't native-driver capable: one small JS animation per fix.
    const glide = { duration: GLIDE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: false };
    Animated.parallel([
      Animated.timing(latitude, { ...glide, toValue: next.latitude }),
      Animated.timing(longitude, { ...glide, toValue: next.longitude }),
    ]).start();
  }, [zone.latitude, zone.longitude, reduceMotion, latitude, longitude]);

  return (
    <Marker.Animated
      coordinate={coordinate}
      title={zone.label}
      onPress={onPress}
      anchor={{ x: 0.5, y: 0.5 }}
      rotation={heading}
      flat
      tracksViewChanges={!ready}
      zIndex={3}
    >
      <Image
        source={illustrations.carTopdown}
        style={{ width: CAR_SIZE, height: CAR_SIZE }}
        resizeMode="contain"
        onLoad={() => setReady(true)}
      />
    </Marker.Animated>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Largest radius of the pickup pulse, in metres on the ground. */
const PULSE_MAX_RADIUS_M = 70;
/** PulseRings' look (design/components/PulseRings): green at 22%, fading out. */
const PULSE_OPACITY = 0.22;

/**
 * PulseRings on the map: two rings growing out from a point and fading, the
 * second half a cycle behind. Drawn as native map Circles (radius in metres)
 * rather than PulseRings inside a marker: they stay on the point as the map
 * moves, and a custom Marker only animates on Android with tracksViewChanges
 * on, which re-rasterizes it every frame. With Reduce Motion on they stand
 * still, faint, as PulseRings does.
 */
function ZonePulse({ center }: { center: LatLng }) {
  return (
    <>
      <PulseCircle center={center} delay={0} still={0.55} />
      <PulseCircle center={center} delay={PULSE_MS / 2} still={1} />
    </>
  );
}

function PulseCircle({ center, delay, still }: { center: LatLng; delay: number; still: number }) {
  const reduceMotion = useReduceMotion();
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(still);
      return;
    }
    progress.setValue(0);
    // Circle props aren't native-driver capable, so this runs on JS — but it
    // is two small values, and only while this screen shows them.
    const loop = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(
        Animated.timing(progress, {
          toValue: 1,
          duration: PULSE_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: false,
        }),
      ),
    ]);
    loop.start();
    return () => loop.stop();
  }, [progress, reduceMotion, delay, still]);

  const fill = reduceMotion
    ? withAlpha(colors.green500, PULSE_OPACITY / 3)
    : progress.interpolate({
        inputRange: [0, 1],
        outputRange: [withAlpha(colors.green500, PULSE_OPACITY), withAlpha(colors.green500, 0)],
      });

  return (
    <AnimatedCircle
      center={{ latitude: center.latitude, longitude: center.longitude }}
      radius={progress.interpolate({
        inputRange: [0, 1],
        outputRange: [PULSE_MAX_RADIUS_M * 0.15, PULSE_MAX_RADIUS_M],
      })}
      fillColor={fill}
      strokeColor="transparent"
      strokeWidth={0}
      zIndex={1}
    />
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
  container: {
    overflow: "hidden",
    borderRadius: radii.lg,
    backgroundColor: colors.surface2,
  },
  unrounded: {
    borderRadius: 0,
  },
  recenterButton: {
    position: "absolute",
    right: spacing.gutter,
  },
});
