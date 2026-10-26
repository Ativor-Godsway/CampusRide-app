import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Image,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import LottieView from "lottie-react-native";
import * as Device from "expo-device";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusChip, colors, spacing } from "../../design";

/**
 * The welcome animation (assets/welcome/welcome.json, from the designer: a
 * car drives across campus and parks at the Balme Library, under the
 * CampusRide logo). 1080 x 1920 at 60 fps, 240 frames. welcome-end.png is its
 * last frame, for Reduce Motion and slow Android phones.
 *
 * Where things sit in the 1080 x 1920 composition, measured from its frames:
 */
const COMP = { width: 1080, height: 1920 };
/** The logo mark's top (with a little room): everything above is sky. */
const LOGO_TOP = 660;
/** Just under the logo's loading pill: where the driver app's chip goes. */
const BADGE_TOP = 1010;
/** The road (#333333) from here to the bottom, with a dashed centre line. */
const ROAD_TOP = 1621;
const ROAD_COLOR = "#333333";
const DASH = { top: 1773, height: 24, length: 60, period: 121.625, firstX: 63 };

/** The logo stays this far below the status bar. */
const STATUS_GAP = spacing[2];

/* eslint-disable @typescript-eslint/no-require-imports -- Metro bundles the animation and image via require() */
const animation = require("../../../assets/welcome/welcome.json");
const lastFrame = require("../../../assets/welcome/welcome-end.png");
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Phones too slow for the animation's ~36 masks get the last frame instead:
 * under 3 GB of memory, or a year class before 2017. iPhones play it.
 */
function isSlowAndroid(): boolean {
  if (Platform.OS !== "android") return false;
  const memory = Device.totalMemory;
  const year = Device.deviceYearClass;
  return (memory !== null && memory < 3e9) || (year !== null && year < 2017);
}

/** Reduce Motion, or null until the phone has answered (so nothing starts and stops). */
function useReduceMotionSetting(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => mounted && setReduce(v));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/**
 * How big to draw the composition in a hero this size, and where. It sits on
 * the hero's bottom edge (road, car and building always whole) and fills the
 * width, cropping sky at the top. When the hero is too short for that — a
 * small phone — it shrinks until the logo clears the status bar, and the road
 * continues to the screen edges behind it.
 */
export function heroFrame(width: number, height: number, topInset: number) {
  const fitWidth = width / COMP.width;
  const fitLogo = (height - topInset - STATUS_GAP) / (COMP.height - LOGO_TOP);
  let scale = Math.min(fitWidth, fitLogo);
  // A hero taller than the whole composition: fill it, cropping the sides.
  if (COMP.height * scale < height) scale = height / COMP.height;
  return {
    scale,
    left: (width - COMP.width * scale) / 2,
    top: height - COMP.height * scale,
    width: COMP.width * scale,
    height: COMP.height * scale,
  };
}

/**
 * The green hero of the welcome screen: the animation plays once when the
 * screen opens and holds on its last frame (the car parked at the library).
 * With Reduce Motion on, or on a slow Android phone, the last frame shows
 * still. `badge` (the driver app's "DRIVER") sits under the animation's logo.
 */
export function WelcomeHero({ badge }: { badge?: string }) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionSetting();
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
  };

  const frame = size ? heroFrame(size.width, size.height, insets.top) : null;
  const still = reduceMotion === true || isSlowAndroid();

  return (
    <View
      style={styles.hero}
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`CampusRide${badge ? ` ${badge}` : ""}. A car arriving at the Balme Library.`}
    >
      {frame ? (
        <>
          <RoadEdges frame={frame} heroWidth={size!.width} />
          {still ? (
            <Image
              testID="welcome-still"
              source={lastFrame}
              style={frameStyle(frame)}
              resizeMode="contain"
            />
          ) : reduceMotion === false ? (
            <LottieView
              testID="welcome-animation"
              source={animation}
              autoPlay
              loop={false}
              resizeMode="contain"
              style={frameStyle(frame)}
            />
          ) : null}
          {badge ? (
            <View style={[styles.badgeRow, { top: frame.top + BADGE_TOP * frame.scale }]}>
              <StatusChip label={badge} tone="amber" style={styles.badge} />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function frameStyle(frame: ReturnType<typeof heroFrame>) {
  return {
    position: "absolute" as const,
    left: frame.left,
    top: frame.top,
    width: frame.width,
    height: frame.height,
  };
}

/**
 * The road and its dashes, continued past the composition's sides when it's
 * narrower than the screen. Behind the animation, so it only shows at the
 * edges; the dashes line up with the last frame's.
 */
function RoadEdges({
  frame,
  heroWidth,
}: {
  frame: ReturnType<typeof heroFrame>;
  heroWidth: number;
}) {
  if (frame.left <= 0) return null;
  const s = frame.scale;
  const dashes: number[] = [];
  // Dash starts in composition units, from off the left edge to off the right.
  const first = DASH.firstX - Math.ceil((frame.left / s + DASH.firstX) / DASH.period) * DASH.period;
  for (let x = first; x * s + frame.left < heroWidth; x += DASH.period) dashes.push(x);
  return (
    <View
      pointerEvents="none"
      style={[styles.road, { top: frame.top + ROAD_TOP * s }]}
      importantForAccessibility="no-hide-descendants"
    >
      {dashes.map((x) => (
        <View
          key={x}
          style={[
            styles.dash,
            {
              left: frame.left + x * s,
              top: (DASH.top - ROAD_TOP) * s,
              width: DASH.length * s,
              height: DASH.height * s,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fills what the words and the button leave, so nothing gapes above the button.
  hero: {
    flex: 1,
    minHeight: 360,
    backgroundColor: colors.green500,
    overflow: "hidden",
  },
  road: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: ROAD_COLOR,
  },
  dash: {
    position: "absolute",
    backgroundColor: colors.white,
  },
  badgeRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  // StatusChip sits at the start of its row by default.
  badge: {
    alignSelf: "center",
  },
});
