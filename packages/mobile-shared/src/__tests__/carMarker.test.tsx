import { AccessibilityInfo, Animated, Platform, StyleSheet } from "react-native";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import type MapView from "react-native-maps";
import { CarMarker, useMapHeading, type CampusMapZone } from "../maps/CampusMapView";

/**
 * The driver's car on a map faces the way it is going, on both platforms:
 * on iOS (Apple Maps ignores a Marker's rotation) the image is turned, minus
 * the map's own heading; on Android the native marker's rotation is set,
 * which keeps working after the marker stops tracking its image.
 */

// A Marker that renders its props onto a View, with the Animated variant CarMarker uses.
jest.mock("react-native-maps", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const RN = jest.requireActual<typeof import("react-native")>("react-native");
  class Marker extends React.Component<object> {
    static Animated: unknown;
    render() {
      return React.createElement(RN.View, { testID: "car-marker", ...this.props });
    }
  }
  Marker.Animated = RN.Animated.createAnimatedComponent(Marker);
  return {
    __esModule: true,
    default: RN.View,
    Marker,
    Polyline: RN.View,
    Circle: RN.View,
    PROVIDER_DEFAULT: undefined,
  };
});

// 0.0001° is about 11 m on campus.
const START = { latitude: 5.65, longitude: -0.187 };
const EAST = { latitude: 5.65, longitude: -0.1869 };
const NORTH_EAST = { latitude: 5.6501, longitude: -0.1869 };
/** A road east from START, and a spot along it. */
const ROAD = [START, { latitude: 5.65, longitude: -0.185 }];
const ON_ROAD = { latitude: 5.65, longitude: -0.186 };

const car = (at: { latitude: number; longitude: number }): CampusMapZone => ({
  id: "car",
  label: "You",
  role: "driver",
  ...at,
});

/** The image's rotation on iOS, in degrees (null when it isn't rotated). */
function imageDegrees(): number | null {
  const style = StyleSheet.flatten(screen.getByTestId("car-marker-image").props.style);
  const rotate = (style.transform as { rotate?: string }[] | undefined)?.find((t) => t.rotate)?.rotate;
  return rotate === undefined ? null : parseFloat(rotate);
}

const markerProps = () => screen.getByTestId("car-marker").props as { rotation?: number; flat?: boolean };

async function show(reduceMotion: boolean, props: Parameters<typeof CarMarker>[0]) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduceMotion);
  const view = await render(<CarMarker {...props} />);
  // Let useReduceMotion's answer land.
  await act(async () => {});
  return view;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("CarMarker on iOS", () => {
  beforeEach(() => jest.replaceProperty(Platform, "OS", "ios"));

  it("turns the image itself to the direction of travel, not the marker", async () => {
    const view = await show(true, { zone: car(START) });
    expect(imageDegrees()).toBe(0);
    await view.rerender(<CarMarker zone={car(EAST)} />);
    expect(imageDegrees()).toBeCloseTo(90, 0);
    expect(markerProps().rotation).toBeUndefined();
    expect(markerProps().flat).toBe(false);
  });

  it("takes off the map's own heading when the map is turned", async () => {
    const mapHeading = new Animated.Value(0);
    const view = await show(true, { zone: car(START), mapHeading });
    await view.rerender(<CarMarker zone={car(EAST)} mapHeading={mapHeading} />);
    expect(imageDegrees()).toBeCloseTo(90, 0);
    // The rider turns the map so east is at the top: the car points up.
    await act(async () => mapHeading.setValue(90));
    expect(imageDegrees()).toBeCloseTo(0, 0);
    await act(async () => mapHeading.setValue(180));
    expect(imageDegrees()).toBeCloseTo(-90, 0);
  });

  it("appears facing along the road on its first fix, without turning to it", async () => {
    await show(false, { zone: car(ON_ROAD), route: ROAD });
    expect(imageDegrees()).toBeCloseTo(90, 0);
  });

  it("faces along a road that arrives after its first fix", async () => {
    const view = await show(true, { zone: car(ON_ROAD) });
    expect(imageDegrees()).toBe(0);
    await view.rerender(<CarMarker zone={car(ON_ROAD)} route={ROAD} />);
    expect(imageDegrees()).toBeCloseTo(90, 0);
  });

  it("doesn't turn for GPS jitter while parked", async () => {
    const view = await show(true, { zone: car(START) });
    await view.rerender(<CarMarker zone={car(EAST)} />);
    await view.rerender(<CarMarker zone={car({ latitude: 5.65001, longitude: -0.18691 })} />);
    expect(imageDegrees()).toBeCloseTo(90, 0);
  });

  it("turns the short way round across north", async () => {
    const view = await show(true, { zone: car(START) });
    await view.rerender(<CarMarker zone={car(NORTH_EAST)} />); // ~45°
    // Then slightly west of north: back through 0, not round through 180.
    await view.rerender(<CarMarker zone={car({ latitude: 5.6502, longitude: -0.18691 })} />);
    const degrees = imageDegrees()!;
    expect(degrees).toBeLessThan(0);
    expect(degrees).toBeGreaterThan(-10);
  });

  it("turns over the same one-second glide as its position", async () => {
    jest.useFakeTimers();
    const view = await show(false, { zone: car(START) });
    await view.rerender(<CarMarker zone={car(EAST)} />);
    await act(async () => jest.advanceTimersByTime(500));
    const midway = imageDegrees()!;
    expect(midway).toBeGreaterThan(5);
    expect(midway).toBeLessThan(85);
    await act(async () => jest.advanceTimersByTime(600));
    expect(imageDegrees()).toBeCloseTo(90, 0);
  });
});

describe("CarMarker for the Home map's cars", () => {
  beforeEach(() => jest.replaceProperty(Platform, "OS", "ios"));

  const latitudeNow = () => {
    const coordinate = markerProps() as unknown as { coordinate: { latitude: unknown } };
    const lat = coordinate.coordinate.latitude;
    return typeof lat === "number" ? lat : (lat as { __getValue(): number }).__getValue();
  };

  it("faces the heading it is given, not the way it moved", async () => {
    const view = await show(true, { zone: car(START), heading: 180 });
    expect(imageDegrees()).toBeCloseTo(180, 0);
    await view.rerender(<CarMarker zone={car(EAST)} heading={180} />);
    expect(imageDegrees()).toBeCloseTo(180, 0);
    // A new heading while standing still turns it too.
    await view.rerender(<CarMarker zone={car(EAST)} heading={270} />);
    expect(imageDegrees()).toBeCloseTo(270, 0);
    // None given: it faces the way it moves, as the driver's own car does.
    await view.rerender(<CarMarker zone={car(NORTH_EAST)} heading={null} />);
    expect(imageDegrees()! % 360).toBeCloseTo(0, 0);
  });

  const north = { latitude: START.latitude + 0.001, longitude: START.longitude };

  it("glides steadily the whole time between updates (glideMs)", async () => {
    jest.useFakeTimers();
    const view = await show(false, { zone: car(START), glideMs: 10_000 });
    await view.rerender(<CarMarker zone={car(north)} glideMs={10_000} />);
    await act(async () => jest.advanceTimersByTime(5_000));
    expect(latitudeNow()).toBeCloseTo(START.latitude + 0.0005, 4);
    await act(async () => jest.advanceTimersByTime(5_100));
    expect(latitudeNow()).toBeCloseTo(north.latitude, 6);
  });

  it("jumps to each update with Reduce Motion on", async () => {
    const view = await show(true, { zone: car(START), glideMs: 10_000 });
    await view.rerender(<CarMarker zone={car(north)} glideMs={10_000} />);
    // Rendered once more so the marker's props show the value it was set to.
    await view.rerender(<CarMarker zone={car(north)} glideMs={10_000} />);
    expect(latitudeNow()).toBeCloseTo(north.latitude, 6);
  });
});

describe("CarMarker on Android", () => {
  beforeEach(() => jest.replaceProperty(Platform, "OS", "android"));

  it("sets the native marker's rotation (flat, so it turns with the map) and leaves the image alone", async () => {
    const view = await show(true, { zone: car(START) });
    await view.rerender(<CarMarker zone={car(EAST)} />);
    expect(markerProps().rotation).toBeCloseTo(90, 0);
    expect(markerProps().flat).toBe(true);
    expect(imageDegrees()).toBeNull();
  });

  it("keeps turning after the image has loaded and the marker stops tracking it", async () => {
    const view = await show(true, { zone: car(START) });
    await fireEvent(screen.getByTestId("car-marker-image"), "load");
    expect(screen.getByTestId("car-marker").props.tracksViewChanges).toBe(false);
    await view.rerender(<CarMarker zone={car(NORTH_EAST)} />);
    expect(markerProps().rotation).toBeCloseTo(45, 0);
  });
});

describe("useMapHeading", () => {
  /** What an Animated.Value holds now (through its internal reader; tests only). */
  const valueOf = (v: Animated.Value) => (v as unknown as { __getValue(): number }).__getValue();

  function fakeMap(headings: number[]) {
    const pending: (() => void)[] = [];
    const getCamera = jest.fn(
      () =>
        new Promise<{ heading: number }>((resolve) => {
          const heading = headings.shift() ?? 0;
          pending.push(() => resolve({ heading }));
        }),
    );
    return { ref: { current: { getCamera } as unknown as MapView }, getCamera, pending };
  }

  it("on iOS reads the map's heading as the camera moves", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const map = fakeMap([30]);
    const { result } = await renderHook(() => useMapHeading(map.ref));
    await act(async () => {
      result.current.onCameraMove!();
      map.pending.shift()!();
    });
    expect(valueOf(result.current.mapHeading)).toBe(30);
  });

  it("reads one camera at a time, plus one more for moves made meanwhile", async () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const map = fakeMap([10, 20]);
    const { result } = await renderHook(() => useMapHeading(map.ref));
    await act(async () => {
      result.current.onCameraMove!();
      result.current.onCameraMove!();
      result.current.onCameraMove!();
    });
    expect(map.getCamera).toHaveBeenCalledTimes(1);
    await act(async () => map.pending.shift()!());
    expect(map.getCamera).toHaveBeenCalledTimes(2);
    await act(async () => map.pending.shift()!());
    expect(map.getCamera).toHaveBeenCalledTimes(2);
    expect(valueOf(result.current.mapHeading)).toBe(20);
  });

  it("on Android sends no camera events: Google Maps turns the flat car with the map", async () => {
    jest.replaceProperty(Platform, "OS", "android");
    const map = fakeMap([30]);
    const { result } = await renderHook(() => useMapHeading(map.ref));
    expect(result.current.onCameraMove).toBeUndefined();
    expect(valueOf(result.current.mapHeading)).toBe(0);
  });
});
