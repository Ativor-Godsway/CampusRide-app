import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Animated, Easing, Image, Platform, StyleSheet, Text, View } from "react-native";
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT, type Region } from "react-native-maps";
import {
  NEARBY_CARS_POLL_MS,
  carHeading,
  continueAngle,
  routeBearingAt,
  type EdgePadding,
  type NearbyCar,
} from "@rida/shared";
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
  /**
   * The screen's phase (e.g. "searching", "driver arrived"). When set, the map
   * re-fits only when this or `fitTo` changes — a moment later, once the
   * sheet has settled — and on recentre; a new `fitPadding` alone is used by
   * the next fit but doesn't move the map.
   */
  refitKey?: string;
  /** Lifts the recenter button above a bottom sheet covering this many points. */
  controlsBottomInset?: number;
  /** Id of a zone the rider may drag ("Move pin to the exact spot"); reported through onZoneDragEnd. */
  draggableZoneId?: string;
  onZoneDragEnd?: (id: string, point: LatLng) => void;
  /** A soft circle on the map, e.g. how far a pin may be moved. */
  circle?: { center: LatLng; radiusMeters: number } | null;
  /**
   * Move the camera to `initialRegion` whenever it changes (once the map is
   * ready), instead of the screen remounting the map with a `key`: a second
   * Google Maps load blocks a slow Android phone's UI thread for seconds.
   */
  followRegion?: boolean;
  /**
   * Other cars to show (the rider's Home map: GET /rides/nearby-cars), each
   * gliding between updates and facing its heading. Drawn under everything
   * else; not tappable, no title.
   */
  cars?: readonly NearbyCar[];
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
  refitKey,
  controlsBottomInset = 0,
  draggableZoneId,
  onZoneDragEnd,
  circle,
  followRegion = false,
  cars,
}: CampusMapViewProps) {
  const mapRef = useRef<MapView>(null);
  const reduceMotion = useReduceMotion();
  const [mapReady, setMapReady] = useState(false);
  const { mapHeading, onCameraMove } = useMapHeading(mapRef);
  const pulseZone = pulseZoneId ? zones.find((z) => z.id === pulseZoneId) : undefined;

  // Stable key: re-fit only when the points or padding (or, with refitKey,
  // the phase) really change, not on every render that builds a new (equal) array.
  const settles = refitKey !== undefined;
  const fitKey = fitTo?.length
    ? JSON.stringify([
        fitTo.map((p) => [p.latitude.toFixed(6), p.longitude.toFixed(6)]),
        settles ? refitKey : (fitPadding ?? null),
      ])
    : null;
  const fitRef = useRef({ fitTo, fitPadding });
  fitRef.current = { fitTo, fitPadding };

  const fit = useCallback((animated: boolean) => {
    const { fitTo: points, fitPadding: padding } = fitRef.current;
    if (!points?.length) return false;
    mapRef.current?.fitToCoordinates(points, { edgePadding: padding, animated });
    return true;
  }, []);

  // followRegion: the region the camera is at (set when the map is ready, as
  // the map opened there); a different one later is animated to.
  const regionKey = `${initialRegion.latitude.toFixed(5)},${initialRegion.longitude.toFixed(5)},${initialRegion.latitudeDelta.toFixed(4)}`;
  const shownRegion = useRef<string | null>(null);
  const regionRef = useRef(initialRegion);
  regionRef.current = initialRegion;
  useEffect(() => {
    if (!followRegion || !mapReady) return;
    if (shownRegion.current === null) {
      shownRegion.current = regionKey;
      return;
    }
    if (shownRegion.current === regionKey) return;
    shownRegion.current = regionKey;
    mapRef.current?.animateToRegion(regionRef.current, reduceMotion ? 0 : 400);
  }, [followRegion, mapReady, regionKey, reduceMotion]);

  useEffect(() => {
    if (!mapReady || !fitKey) return;
    if (!settles) {
      fit(!reduceMotion);
      return;
    }
    const timer = setTimeout(() => fit(!reduceMotion), FIT_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [mapReady, fitKey, fit, reduceMotion, settles]);

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
        onRegionChange={onCameraMove}
        onRegionChangeComplete={onCameraMove}
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

        {cars?.map((car) => (
          <CarMarker
            key={car.key}
            zone={{ id: car.key, label: "", latitude: car.latitude, longitude: car.longitude }}
            heading={car.heading}
            glideMs={NEARBY_CARS_POLL_MS}
            mapHeading={mapHeading}
            zIndex={1}
          />
        ))}

        {/* Every marker is a 3D render (docs/design-system.md, Iconography): a
            place without a role gets the drop-off pin. */}
        {zones.map((zone) =>
          zone.role === "driver" ? (
            <CarMarker
              key={`${zone.id}:${zone.version ?? 0}`}
              zone={zone}
              onPress={() => onZonePress?.(zone.id)}
              route={routeIsRoad ? routeLine : undefined}
              mapHeading={mapHeading}
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

/**
 * The map's own heading (the compass direction at the top of the screen),
 * for CarMarker. Apple Maps keeps markers upright on screen when the rider
 * turns the map, so on iOS the car takes the map's heading off its own;
 * pass `onCameraMove` to the MapView's onRegionChange and
 * onRegionChangeComplete. Google Maps turns a flat marker with the map by
 * itself, so on Android this stays 0 and `onCameraMove` is undefined (no
 * events sent across).
 */
export function useMapHeading(mapRef: RefObject<MapView | null>): {
  mapHeading: Animated.Value;
  onCameraMove: (() => void) | undefined;
} {
  const mapHeading = useRef(new Animated.Value(0)).current;
  const reading = useRef(false);
  const readAgain = useRef(false);

  // One camera read at a time: moves that arrive meanwhile ask for one more
  // read when it finishes, so a turning gesture costs a read per frame at most.
  const read = useCallback(() => {
    const map = mapRef.current;
    if (!map) {
      reading.current = false;
      return;
    }
    reading.current = true;
    map
      .getCamera()
      .then((camera) => mapHeading.setValue(camera.heading ?? 0))
      .catch(() => undefined)
      .finally(() => {
        if (readAgain.current) {
          readAgain.current = false;
          read();
        } else {
          reading.current = false;
        }
      });
  }, [mapRef, mapHeading]);

  const onCameraMove = useCallback(() => {
    if (reading.current) readAgain.current = true;
    else read();
  }, [read]);

  return { mapHeading, onCameraMove: Platform.OS === "ios" ? onCameraMove : undefined };
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
/**
 * The car's glide, for its position and its turn alike. Map coordinates and
 * marker rotation aren't native-driver capable: small JS animations, one per fix.
 */
const GLIDE = { duration: GLIDE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: false } as const;
/** With refitKey: how long a phase change waits for the sheet to settle before fitting. */
const FIT_SETTLE_MS = 450;

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
 * The driver's top-down car (car-topdown.png: nose up, so 0° = north). It
 * faces its direction of travel — the road's direction where it is on
 * `route`, otherwise the way it moved between its last two fixes (see
 * carHeading) — and glides to each new GPS fix instead of jumping, turning
 * the short way round over the same glide; with Reduce Motion on it jumps.
 *
 * How it turns differs by platform. Apple Maps ignores a Marker's
 * `rotation`, so on iOS the image itself is rotated, minus the map's own
 * heading (`mapHeading`, from useMapHeading) since Apple Maps keeps markers
 * upright on screen. On Android the image is a bitmap that stops updating
 * once loaded (tracksViewChanges off, which keeps Android smooth), so the
 * turn goes to the native marker's `rotation` instead, which Google Maps
 * applies to the bitmap as it is; `flat` makes it turn with the map.
 *
 * Exported for maps of their own (the driver's trip map); give it a
 * MapView parent.
 */
export function CarMarker({
  zone,
  onPress,
  route,
  mapHeading,
  heading: givenHeading,
  glideMs,
  zIndex = 3,
}: {
  zone: CampusMapZone;
  onPress?: () => void;
  /** The road route the car is driving, when there is one: the car follows its direction. */
  route?: readonly LatLng[] | null;
  /** The map's heading (useMapHeading); used on iOS only. */
  mapHeading?: Animated.Value;
  /** The way the car faces, when known from elsewhere (the server); null or absent: worked out from its moves. */
  heading?: number | null;
  /**
   * How long a move takes, for positions that arrive this far apart (the
   * Home map's cars, every 10 s): a steady glide the whole way, so the car
   * keeps moving instead of jumping and waiting. Default: GLIDE_MS, eased.
   */
  glideMs?: number;
  zIndex?: number;
}) {
  const reduceMotion = useReduceMotion();
  const ios = Platform.OS === "ios";
  const [ready, setReady] = useState(false);
  const last = useRef<LatLng | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const givenHeadingRef = useRef(givenHeading);
  givenHeadingRef.current = givenHeading;
  const moveGlide = useMemo(
    () => (glideMs ? { duration: glideMs, easing: Easing.linear, useNativeDriver: false } : GLIDE),
    [glideMs],
  );
  /** Compass heading the car is turning to; null until known (it shows nose-north). */
  const heading = useRef<number | null>(null);
  /** The drawn angle. Not kept to [0, 360): it counts on past a full turn so each turn goes the short way. */
  const angle = useRef(new Animated.Value(0)).current;
  const northUp = useRef(new Animated.Value(0)).current;
  const latitude = useRef(new Animated.Value(zone.latitude)).current;
  const longitude = useRef(new Animated.Value(zone.longitude)).current;
  const coordinate = useRef({ latitude, longitude }).current;

  /** `appear`: the car's first fix, where it shows up already facing its way rather than turning to it. */
  const turnTo = useCallback(
    (facing: number | null, appear = false) => {
      if (facing === null || facing === heading.current) return;
      heading.current = facing;
      angle.stopAnimation((now) => {
        const toValue = continueAngle(now, facing);
        if (reduceMotion || appear) angle.setValue(toValue);
        else Animated.timing(angle, { ...GLIDE, toValue }).start();
      });
    },
    [angle, reduceMotion],
  );

  useEffect(() => {
    const prev = last.current;
    const next = { latitude: zone.latitude, longitude: zone.longitude };
    last.current = next;
    const given = givenHeadingRef.current;
    turnTo(
      given ?? carHeading({ previous: prev, current: next, route: routeRef.current, heading: heading.current }),
      !prev,
    );
    if (!prev) return;
    latitude.stopAnimation();
    longitude.stopAnimation();
    if (reduceMotion) {
      latitude.setValue(next.latitude);
      longitude.setValue(next.longitude);
      return;
    }
    Animated.parallel([
      Animated.timing(latitude, { ...moveGlide, toValue: next.latitude }),
      Animated.timing(longitude, { ...moveGlide, toValue: next.longitude }),
    ]).start();
  }, [zone.latitude, zone.longitude, reduceMotion, latitude, longitude, turnTo, moveGlide]);

  // A heading given from elsewhere that changes while the car stands still.
  useEffect(() => {
    if (givenHeading !== null && givenHeading !== undefined && last.current) turnTo(givenHeading);
  }, [givenHeading, turnTo]);

  // A route that arrives after the first fix still turns a car that hasn't
  // moved yet to face along the road.
  useEffect(() => {
    if (heading.current === null && last.current) turnTo(routeBearingAt(last.current, route));
  }, [route, turnTo]);

  const rotate = useMemo(
    () =>
      Animated.subtract(angle, mapHeading ?? northUp).interpolate({
        inputRange: [0, 360],
        outputRange: ["0deg", "360deg"],
        extrapolate: "extend",
      }),
    [angle, mapHeading, northUp],
  );

  return (
    <Marker.Animated
      coordinate={coordinate}
      title={zone.label || undefined}
      onPress={onPress}
      anchor={{ x: 0.5, y: 0.5 }}
      rotation={ios ? undefined : angle}
      flat={!ios}
      tracksViewChanges={!ready}
      zIndex={zIndex}
    >
      <Animated.Image
        testID="car-marker-image"
        source={illustrations.carTopdown}
        style={[{ width: CAR_SIZE, height: CAR_SIZE }, ios && { transform: [{ rotate }] }]}
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
