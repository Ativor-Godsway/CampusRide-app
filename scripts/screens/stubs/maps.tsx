/**
 * Maps don't render on the web: a plain grey box where the map would be.
 *
 * With `--map-art` (window.__screensMapArt, set by run.mjs) it draws a map
 * instead, for pictures meant for people rather than for reviewing layout:
 * the real roads around Legon (assets/map/legon-osm.json, OpenStreetMap) and the app's
 * own markers, route lines and circles at their coordinates, framed the way
 * the app frames them (initialRegion, then fitToCoordinates).
 */
import {
  createContext,
  createElement,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { MAP_ATTRIBUTION, areas, point, roads, type LatLng } from "../map/roads";

const noop = () => undefined;
const mapArt = Boolean((globalThis as { __screensMapArt?: boolean }).__screensMapArt);

export type Region = {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
};
type Padding = { top?: number; right?: number; bottom?: number; left?: number };

// ─── Projection (Web Mercator, as the map SDKs use) ─────────────────────────

/** Mercator y of a latitude, in "degrees" so it scales like longitude. */
const mercY = (lat: number) =>
  (Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * 180) / Math.PI;
/** Closest the SDKs zoom in (about zoom 18): pixels per degree of longitude. */
const MAX_SCALE = (256 * 2 ** 18) / 360;

/** Where the map's centre is and how many pixels a degree of longitude takes. */
type Camera = { lng: number; merc: number; scale: number };

function fitCamera(points: LatLng[], width: number, height: number, pad: Padding = {}): Camera {
  const lats = points.map((p) => p.latitude);
  const lngs = points.map((p) => p.longitude);
  const [top, bottom] = [mercY(Math.max(...lats)), mercY(Math.min(...lats))];
  const [west, east] = [Math.min(...lngs), Math.max(...lngs)];
  const w = Math.max(width - (pad.left ?? 0) - (pad.right ?? 0), 40);
  const h = Math.max(height - (pad.top ?? 0) - (pad.bottom ?? 0), 40);
  const scale = Math.min(w / Math.max(east - west, 1e-9), h / Math.max(top - bottom, 1e-9), MAX_SCALE);
  // The points' centre goes to the middle of the padded area.
  const offsetX = ((pad.left ?? 0) - (pad.right ?? 0)) / 2;
  const offsetY = ((pad.top ?? 0) - (pad.bottom ?? 0)) / 2;
  return {
    lng: (west + east) / 2 - offsetX / scale,
    merc: (top + bottom) / 2 + offsetY / scale,
    scale,
  };
}

const regionCamera = (r: Region, width: number, height: number) =>
  fitCamera(
    [
      { latitude: r.latitude - r.latitudeDelta / 2, longitude: r.longitude - r.longitudeDelta / 2 },
      { latitude: r.latitude + r.latitudeDelta / 2, longitude: r.longitude + r.longitudeDelta / 2 },
    ],
    width,
    height,
  );

type Projector = {
  project: (p: LatLng) => { x: number; y: number };
  /** Pixels per metre on the ground, at this latitude. */
  pxPerMetre: number;
};
const MapContext = createContext<Projector | null>(null);

function projector(camera: Camera, width: number, height: number): Projector {
  const lat = (Math.atan(Math.sinh((camera.merc * Math.PI) / 180)) * 180) / Math.PI;
  return {
    project: (p) => ({
      x: width / 2 + (p.longitude - camera.lng) * camera.scale,
      y: height / 2 - (mercY(p.latitude) - camera.merc) * camera.scale,
    }),
    pxPerMetre: camera.scale / (111320 * Math.cos((lat * Math.PI) / 180)),
  };
}

// ─── The drawn map ───────────────────────────────────────────────────────────

/** The app's light map look (docs/mockups): pale ground, white roads, soft green parks. */
const LOOK = {
  ground: "#EEF0EB",
  green: "#D5EBDB",
  water: "#CFE3F2",
  casing: "#DADFD8",
  road: "#FFFFFF",
  trunk: "#FFF4D6",
  trunkCasing: "#EFD9A0",
  /** Road widths on the ground in metres, trunk to service, and their least width in px. */
  metres: [16, 12, 9, 7, 5],
  minPx: [5, 4, 3, 2.5, 1.5],
};

const svg = (tag: string, props: Record<string, unknown>, ...children: ReactNode[]) =>
  createElement(tag, props, ...children);

function Ground({ map, width, height }: { map: Projector; width: number; height: number }) {
  const path = (nodes: number[], close = false) =>
    nodes
      .map((n, i) => {
        const { x, y } = map.project(point(n));
        return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join("") + (close ? "Z" : "");
  const widths = LOOK.metres.map((m, i) => Math.max(m * map.pxPerMetre, LOOK.minPx[i]));
  const lines = (pass: "casing" | "fill") =>
    roads.map(([cls, , nodes], i) =>
      svg("path", {
        key: `${pass}${i}`,
        d: path(nodes),
        fill: "none",
        stroke:
          pass === "casing"
            ? cls === 0
              ? LOOK.trunkCasing
              : LOOK.casing
            : cls === 0
              ? LOOK.trunk
              : LOOK.road,
        strokeWidth: widths[cls] + (pass === "casing" ? 1.5 : 0),
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    );
  return svg(
    "svg",
    {
      width,
      height,
      style: { position: "absolute", left: 0, top: 0 },
      "aria-hidden": true,
    },
    svg("rect", { width, height, fill: LOOK.ground }),
    ...areas.map(([kind, nodes], i) =>
      svg("path", { key: `a${i}`, d: path(nodes, true), fill: kind ? LOOK.water : LOOK.green }),
    ),
    ...lines("casing"),
    ...lines("fill"),
  );
}

/** The app's overlays (markers, lines, circles) need the map's projection. */
function Overlay({ children }: { children: (map: Projector) => ReactNode }) {
  const map = useContext(MapContext);
  return map ? <>{children(map)}</> : null;
}

const MapView = forwardRef(function MapView(
  {
    style,
    children,
    initialRegion,
    onMapReady,
  }: {
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    initialRegion?: Region;
    onMapReady?: () => void;
  },
  ref,
) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  useImperativeHandle(ref, () => ({
    animateToRegion: (region: Region) => {
      const s = sizeRef.current;
      if (mapArt && s) setCamera(regionCamera(region, s.width, s.height));
    },
    animateCamera: noop,
    fitToCoordinates: (points: LatLng[], options?: { edgePadding?: Padding }) => {
      const s = sizeRef.current;
      if (mapArt && s && points.length) {
        setCamera(fitCamera(points, s.width, s.height, options?.edgePadding));
      }
    },
    fitToSuppliedMarkers: noop,
    setCamera: noop,
    getCamera: async () => ({
      center: { latitude: 0, longitude: 0 },
      zoom: 15,
      heading: 0,
      pitch: 0,
    }),
  }));

  // Ready once it has a size, as a real map is once it has drawn.
  const readyCalled = useRef(false);
  useEffect(() => {
    if (!mapArt || !size || readyCalled.current) return;
    readyCalled.current = true;
    if (initialRegion) setCamera(regionCamera(initialRegion, size.width, size.height));
    onMapReady?.();
  }, [size, initialRegion, onMapReady]);

  if (!mapArt) {
    return (
      <View
        style={[
          { backgroundColor: "#D9DCDA", alignItems: "center", justifyContent: "center" },
          style,
        ]}
      >
        <Text style={{ color: "#7A8480", fontSize: 13 }}>Map (not shown on web)</Text>
      </View>
    );
  }

  const map = size && camera ? projector(camera, size.width, size.height) : null;
  return (
    <View
      style={[{ backgroundColor: LOOK.ground, overflow: "hidden" }, style]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (width && height && (width !== size?.width || height !== size?.height)) {
          setSize({ width, height });
        }
      }}
    >
      {map && size ? (
        <MapContext.Provider value={map}>
          <Ground map={map} width={size.width} height={size.height} />
          {svg(
            "svg",
            {
              width: size.width,
              height: size.height,
              style: { position: "absolute", left: 0, top: 0, pointerEvents: "none" },
            },
            <LineLayer key="lines">{children}</LineLayer>,
          )}
          <MarkerLayer>{children}</MarkerLayer>
          <Text
            style={{
              position: "absolute",
              left: 6,
              bottom: 3,
              fontSize: 9,
              color: "#8A938F",
            }}
          >
            {MAP_ATTRIBUTION}
          </Text>
        </MapContext.Provider>
      ) : null}
    </View>
  );
});

/**
 * Lines and circles are SVG inside one <svg>; markers are views above it. The
 * children render twice, once per layer, and each kind draws itself only in
 * its own layer.
 */
const LayerContext = createContext<"lines" | "markers">("markers");
const LineLayer = ({ children }: { children?: ReactNode }) => (
  <LayerContext.Provider value="lines">{children}</LayerContext.Provider>
);
const MarkerLayer = ({ children }: { children?: ReactNode }) => (
  <LayerContext.Provider value="markers">{children}</LayerContext.Provider>
);

export default MapView;

// ─── Overlays ────────────────────────────────────────────────────────────────

/** An Animated.Value's current number, or the number itself. */
type Numberish = number | { __getValue?: () => number; addListener?: (cb: () => void) => string };
const valueOf = (v: Numberish | undefined) =>
  typeof v === "number" ? v : (v?.__getValue?.() ?? 0);

/** Re-renders when any of the given Animated.Values changes. */
function useAnimatedValues(values: (Numberish | undefined)[]) {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const subs = values.map((v) =>
      typeof v === "object" && v?.addListener ? [v, v.addListener(bump)] : null,
    );
    return () => {
      for (const sub of subs) {
        if (sub) (sub[0] as { removeListener?: (id: string) => void }).removeListener?.(sub[1] as string);
      }
    };
    // Subscribed once: the values are Animated.Values the app keeps in refs.
  }, []);
}

function MarkerBase({
  coordinate,
  anchor,
  rotation,
  children,
}: {
  coordinate?: { latitude: Numberish; longitude: Numberish };
  anchor?: { x: number; y: number };
  rotation?: Numberish;
  children?: ReactNode;
}) {
  const layer = useContext(LayerContext);
  useAnimatedValues([coordinate?.latitude, coordinate?.longitude, rotation]);
  if (!mapArt || layer !== "markers" || !coordinate) return null;
  const at = { latitude: valueOf(coordinate.latitude), longitude: valueOf(coordinate.longitude) };
  const { x: ax, y: ay } = anchor ?? { x: 0.5, y: 1 };
  return (
    <Overlay>
      {(map) => {
        const { x, y } = map.project(at);
        return createElement(
          "div",
          {
            style: {
              position: "absolute",
              left: x,
              top: y,
              transform: `translate(${-ax * 100}%, ${-ay * 100}%) rotate(${valueOf(rotation)}deg)`,
              transformOrigin: `${ax * 100}% ${ay * 100}%`,
              display: "flex",
            },
          },
          children,
        );
      }}
    </Overlay>
  );
}

export const Marker = Object.assign(MarkerBase, { Animated: MarkerBase });

/** react-native-maps colours can be rgba() strings or hex: SVG takes both. */
export function Polyline({
  coordinates,
  strokeColor = "#000",
  strokeWidth = 1,
  lineDashPattern,
}: {
  coordinates: LatLng[];
  strokeColor?: string;
  strokeWidth?: number;
  lineDashPattern?: number[];
}) {
  const layer = useContext(LayerContext);
  if (!mapArt || layer !== "lines" || coordinates.length < 2) return null;
  return (
    <Overlay>
      {(map) =>
        svg("path", {
          d: coordinates
            .map((p, i) => {
              const { x, y } = map.project(p);
              return `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(""),
          fill: "none",
          stroke: strokeColor,
          strokeWidth,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeDasharray: lineDashPattern?.join(" "),
        })
      }
    </Overlay>
  );
}

export function Circle({
  center,
  radius,
  fillColor = "transparent",
  strokeColor = "transparent",
  strokeWidth = 1,
}: {
  center: { latitude: Numberish; longitude: Numberish };
  radius: Numberish;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
}) {
  const layer = useContext(LayerContext);
  useAnimatedValues([radius]);
  if (!mapArt || layer !== "lines") return null;
  return (
    <Overlay>
      {(map) => {
        const { x, y } = map.project({
          latitude: valueOf(center.latitude),
          longitude: valueOf(center.longitude),
        });
        return svg("circle", {
          cx: x,
          cy: y,
          r: valueOf(radius) * map.pxPerMetre,
          fill: fillColor,
          stroke: strokeColor,
          strokeWidth,
        });
      }}
    </Overlay>
  );
}

export const Polygon = () => null;
export const Callout = () => null;
export const PROVIDER_DEFAULT = undefined;
export const PROVIDER_GOOGLE = "google";
