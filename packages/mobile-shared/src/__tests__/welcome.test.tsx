import { AccessibilityInfo, Platform } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { WelcomeHero, heroFrame } from "../auth/screens/WelcomeHero";

/**
 * The welcome animation: played once and held (never looped), a still last
 * frame with Reduce Motion on, and framed so the road sits on the hero's
 * bottom edge and the logo clears the status bar on every phone size.
 */

/** The composition's logo top and size (WelcomeHero.tsx). */
const LOGO_TOP = 660;
/** What expo-device reports; a test sets a slow phone's. */
const mockDevice: { totalMemory: number | null; deviceYearClass: number | null } = {
  totalMemory: null,
  deviceYearClass: null,
};
jest.mock("expo-device", () => ({
  get totalMemory() {
    return mockDevice.totalMemory;
  },
  get deviceYearClass() {
    return mockDevice.deviceYearClass;
  },
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 375, height: 667 },
  insets: { top: 20, left: 0, right: 0, bottom: 0 },
};

async function showHero(reduceMotion: boolean, badge?: string) {
  jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduceMotion);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <WelcomeHero badge={badge} />
    </SafeAreaProvider>,
  );
  const hero = screen.getByRole("image");
  await act(async () => {
    fireEvent(hero, "layout", { nativeEvent: { layout: { width: 375, height: 400 } } });
  });
  return hero;
}

afterEach(() => {
  jest.restoreAllMocks();
  mockDevice.totalMemory = null;
  mockDevice.deviceYearClass = null;
});

describe("WelcomeHero", () => {
  it("plays the animation once and holds the last frame", async () => {
    await showHero(false);
    const animation = screen.getByTestId("welcome-animation");
    expect(animation.props.autoPlay).toBe(true);
    expect(animation.props.loop).toBe(false);
    expect(screen.queryByTestId("welcome-still")).toBeNull();
  });

  it("shows the last frame still with Reduce Motion on, never starting the animation", async () => {
    await showHero(true);
    expect(screen.getByTestId("welcome-still")).toBeTruthy();
    expect(screen.queryByTestId("welcome-animation")).toBeNull();
  });

  it("shows the still on a slow Android phone (under 3 GB of memory)", async () => {
    mockDevice.totalMemory = 2e9;
    jest.replaceProperty(Platform, "OS", "android");
    await showHero(false);
    expect(screen.getByTestId("welcome-still")).toBeTruthy();
    expect(screen.queryByTestId("welcome-animation")).toBeNull();
  });

  it("plays on an Android phone with 4 GB", async () => {
    mockDevice.totalMemory = 3.7e9;
    mockDevice.deviceYearClass = 2019;
    jest.replaceProperty(Platform, "OS", "android");
    await showHero(false);
    expect(screen.getByTestId("welcome-animation")).toBeTruthy();
  });

  it("names the driver app's badge for screen readers and shows it", async () => {
    const hero = await showHero(true, "DRIVER");
    expect(hero.props.accessibilityLabel).toMatch(/^CampusRide DRIVER\./);
    expect(screen.getByText("DRIVER")).toBeTruthy();
  });
});

describe("heroFrame", () => {
  // [width, hero height, status bar]: iPhone SE, small Android, iPhone 15, Pro Max.
  const phones: Array<[string, number, number, number]> = [
    ["iPhone SE", 375, 400, 20],
    ["small Android", 360, 399, 24],
    ["iPhone 15", 390, 564, 47],
    ["iPhone Pro Max", 430, 662, 59],
  ];

  it.each(phones)("%s: road on the bottom edge, logo below the status bar", (_, w, h, top) => {
    const f = heroFrame(w, h, top);
    expect(f.top + f.height).toBeCloseTo(h);
    expect(f.top + LOGO_TOP * f.scale).toBeGreaterThanOrEqual(top);
    expect(f.width).toBeLessThanOrEqual(w + 0.001);
    expect(f.left).toBeCloseTo((w - f.width) / 2);
  });

  it("fills the width when the hero is tall enough", () => {
    const f = heroFrame(390, 564, 47);
    expect(f.width).toBeCloseTo(390);
    expect(f.left).toBeCloseTo(0);
  });

  it("never leaves green above the composition in a very tall hero", () => {
    const f = heroFrame(390, 800, 47);
    expect(f.top).toBeLessThanOrEqual(0);
    expect(f.height).toBeGreaterThanOrEqual(800);
  });
});
