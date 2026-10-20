import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { LONG_PRESS_CONFIRM_MS, enteredEndZone, slideProgress, slideRelease } from "@rida/shared";
import { haptics } from "../haptics";
import { colors, radii, spacing, withAlpha } from "../tokens";
import { useReduceMotion } from "./Illustration";
import { Text } from "./Text";

const HEIGHT = 64;
const KNOB = 56;
const PAD = (HEIGHT - KNOB) / 2;
/**
 * Extra inset on each side, so the knob never starts in the screen-edge
 * strip iOS reserves for its own swipe-back gesture.
 */
const EDGE_INSET = spacing[3];

export interface SlideToConfirmProps {
  /** "Slide when Kwame is in", "Kwame picked up", "Cash collected from Ama". */
  label: string;
  /** Shown with a check once it's done: "Picked up". */
  doneLabel?: string;
  onConfirm: () => void;
  /** `brand` (green) by default; `dark` for the cash step. */
  tone?: "brand" | "dark";
}

const TONES = {
  brand: { track: colors.green100, fill: withAlpha(colors.green500, 0.22), label: colors.green700 },
  dark: { track: colors.surfaceDark, fill: colors.surfaceDark2, label: colors.onDark },
} as const;

/**
 * docs/design-system.md, "SlideToConfirm": the driver's irreversible trip
 * steps (picked up, cash collected, dropped off), so a stray tap while
 * driving can't trigger them. It IS the screen's primary action.
 *
 * - Drag the knob right; the fill follows it. Let go past 85% and it
 *   completes (medium haptic, green fill, the done label with a check); let
 *   go before and it springs back.
 * - Or hold the knob still for 600 ms.
 * - VoiceOver / TalkBack: an "activate" action (double-tap) completes it.
 *
 * Built on react-native-gesture-handler (a JS PanResponder loses to native
 * gestures such as iOS swipe-back). The decisions (clamping, the 85% end
 * zone, release) are tested in @rida/shared (driver/slideToConfirm).
 */
export function SlideToConfirm({
  label,
  doneLabel = "Done",
  onConfirm,
  tone = "brand",
}: SlideToConfirmProps) {
  const look = TONES[tone];
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(0);
  const [done, setDone] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  const hold = useRef(new Animated.Value(0)).current;
  const travelRef = useRef(0);
  travelRef.current = Math.max(0, width - KNOB - PAD * 2);
  const progressRef = useRef(0);
  const doneRef = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;
  const reduceRef = useRef(reduceMotion);
  reduceRef.current = reduceMotion;

  // A new label is a new action: put the knob back.
  useEffect(() => {
    doneRef.current = false;
    progressRef.current = 0;
    setDone(false);
    x.setValue(0);
    hold.setValue(0);
  }, [label, x, hold]);

  // The trip normally moves on at once (the next stop brings a fresh slider).
  // If it's still here a moment later (the step was refused and the same
  // stop came back), reset rather than stay stuck at the end.
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => {
      doneRef.current = false;
      progressRef.current = 0;
      setDone(false);
      hold.setValue(0);
      Animated.spring(x, {
        toValue: 0,
        damping: 22,
        stiffness: 220,
        useNativeDriver: true,
      }).start();
    }, 1_500);
    return () => clearTimeout(t);
  }, [done, x, hold]);

  const confirm = useMemo(
    () => () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setDone(true);
      haptics.impactMedium();
      const end = travelRef.current;
      if (reduceRef.current) x.setValue(end);
      else Animated.timing(x, { toValue: end, duration: 120, useNativeDriver: true }).start();
      // The trip updates in the same moment: never held back by an animation.
      confirmRef.current();
    },
    [x],
  );

  const gesture = useMemo(() => {
    const snapBack = () => {
      progressRef.current = 0;
      if (reduceRef.current) x.setValue(0);
      else
        Animated.spring(x, {
          toValue: 0,
          damping: 22,
          stiffness: 220,
          useNativeDriver: true,
        }).start();
    };

    const pan = Gesture.Pan()
      .runOnJS(true)
      // Horizontal drags only; a mostly-vertical move is left alone.
      .activeOffsetX([-6, 6])
      .failOffsetY([-24, 24])
      .shouldCancelWhenOutside(false)
      .onUpdate((e) => {
        if (doneRef.current) return;
        const next = slideProgress(e.translationX, travelRef.current);
        if (enteredEndZone(progressRef.current, next)) haptics.selection();
        progressRef.current = next;
        x.setValue(next * travelRef.current);
      })
      .onEnd(() => {
        if (doneRef.current) return;
        if (slideRelease(progressRef.current) === "confirm") confirm();
        else snapBack();
      })
      .onFinalize((_e, success) => {
        if (!success && !doneRef.current) snapBack();
      });

    const longPress = Gesture.LongPress()
      .runOnJS(true)
      .minDuration(LONG_PRESS_CONFIRM_MS)
      .maxDistance(12)
      .onBegin(() => {
        if (doneRef.current) return;
        hold.setValue(0);
        Animated.timing(hold, {
          toValue: 1,
          duration: LONG_PRESS_CONFIRM_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }).start();
      })
      .onStart(() => confirm())
      .onFinalize(() => {
        hold.stopAnimation();
        if (!doneRef.current)
          Animated.timing(hold, { toValue: 0, duration: 120, useNativeDriver: true }).start();
      });

    // Whichever starts first wins: moving the finger is a slide, holding
    // still is a long-press.
    return Gesture.Race(pan, longPress);
  }, [x, hold, confirm]);

  const travel = travelRef.current;
  const labelOpacity = x.interpolate({
    inputRange: [0, Math.max(1, travel * 0.6)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <View style={styles.inset}>
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={done ? doneLabel : label}
        accessibilityHint="Slide right, or hold for a moment"
        accessibilityState={{ disabled: done }}
        accessibilityActions={[{ name: "activate", label }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "activate") confirm();
        }}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={[styles.track, { backgroundColor: look.track }]}
      >
        {/* The fill: as wide as the track, its right edge kept at the knob's. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.fill,
            {
              width,
              left: KNOB + PAD * 2 - width,
              backgroundColor: done ? colors.green500 : look.fill,
              transform: [{ translateX: x }],
            },
          ]}
        />
        {/* Holding still: the track fills from the left over 600 ms. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.fill,
            {
              width,
              left: -width,
              backgroundColor: withAlpha(colors.green500, 0.18),
              transform: [
                { translateX: hold.interpolate({ inputRange: [0, 1], outputRange: [0, width] }) },
              ],
            },
          ]}
        />
        {done ? (
          <View style={styles.label} pointerEvents="none">
            <Ionicons name="checkmark-circle" size={20} color={colors.onBrand} />
            <Text variant="button" color="onBrand" numberOfLines={1}>
              {doneLabel}
            </Text>
          </View>
        ) : (
          <Animated.View
            style={[styles.label, styles.labelPadded, { opacity: labelOpacity }]}
            pointerEvents="none"
          >
            <Text variant="button" style={{ color: look.label }} numberOfLines={1}>
              {label}
            </Text>
          </Animated.View>
        )}
        <GestureDetector gesture={gesture}>
          <Animated.View
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[styles.knob, { transform: [{ translateX: x }] }]}
          >
            <Ionicons
              name={done ? "checkmark" : "arrow-forward"}
              size={26}
              color={colors.onBrand}
            />
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { marginHorizontal: EDGE_INSET },
  track: {
    height: HEIGHT,
    borderRadius: radii.full,
    padding: PAD,
    justifyContent: "center",
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: radii.full,
  },
  label: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing[2],
  },
  labelPadded: {
    paddingLeft: KNOB + spacing[3],
    paddingRight: spacing[4],
  },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.green500,
  },
});
