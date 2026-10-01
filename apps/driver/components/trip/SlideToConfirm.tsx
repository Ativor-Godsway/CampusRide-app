import { useEffect, useMemo, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import {
  LONG_PRESS_CONFIRM_MS,
  enteredEndZone,
  slideProgress,
  slideRelease,
} from "@rida/shared";
import { Button, Text, colors, radii, spacing, typography, withAlpha } from "@rida/mobile-shared";

const KNOB = 56;
const PAD = 4;
/**
 * Extra inset on each side of the track, on top of the card's padding, so the
 * knob never starts in the screen-edge strip iOS reserves for its own
 * swipe-back gesture.
 */
const EDGE_INSET = spacing.md;

function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isScreenReaderEnabled().then((v) => {
      if (mounted) setOn(v);
    });
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setOn);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return on;
}

/**
 * "Slide: Ama picked up" / "Slide: cash collected". A slide rather than a
 * button so a pocket tap or a brushed thumb can't end a rider's trip.
 *
 * Built on react-native-gesture-handler (not a JS PanResponder, which loses
 * to native gestures such as iOS swipe-back): the knob's pan and long-press
 * are native gesture recognisers. The trip screen also turns swipe-back off
 * while a trip is running, so nothing competes with it.
 *
 * - Drag the knob right: a light haptic when it reaches the end zone; let go
 *   there to confirm (success haptic), anywhere before it and it snaps back.
 * - Or hold the knob still for one second (a fallback if dragging is hard).
 * - With a screen reader on, it's an ordinary button.
 *
 * The decisions (clamping, end zone, release) are tested in @rida/shared
 * (driver/slideToConfirm).
 */
export function SlideToConfirm({
  label,
  onConfirm,
  tone = "primary",
}: {
  label: string;
  onConfirm: () => void;
  tone?: "primary" | "dark";
}) {
  const screenReader = useScreenReader();
  const [width, setWidth] = useState(0);
  /** Confirmed: the knob shows a check mark. */
  const [checked, setChecked] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  const hold = useRef(new Animated.Value(0)).current;
  const travelRef = useRef(0);
  travelRef.current = Math.max(0, width - KNOB - PAD * 2);
  const progressRef = useRef(0);
  const doneRef = useRef(false);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  // A new label is a new action: put the knob back.
  useEffect(() => {
    doneRef.current = false;
    progressRef.current = 0;
    setChecked(false);
    x.setValue(0);
    hold.setValue(0);
  }, [label, x, hold]);

  // The trip normally moves on at once (the parent shows the next stop with a
  // fresh slider). If it's still here a moment later — the step was refused
  // and the same stop came back — reset rather than stay stuck at the end.
  useEffect(() => {
    if (!checked) return;
    const t = setTimeout(() => {
      doneRef.current = false;
      progressRef.current = 0;
      setChecked(false);
      hold.setValue(0);
      Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
    }, 1_500);
    return () => clearTimeout(t);
  }, [checked, x, hold]);

  const gesture = useMemo(() => {
    // Confirm: check mark + success haptic, and the trip updates in the same
    // moment — the step is never held back waiting for an animation.
    const confirm = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setChecked(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      Animated.timing(x, { toValue: travelRef.current, duration: 90, useNativeDriver: true }).start();
      confirmRef.current();
    };
    const snapBack = () => {
      progressRef.current = 0;
      Animated.spring(x, { toValue: 0, useNativeDriver: true, bounciness: 6 }).start();
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
        if (enteredEndZone(progressRef.current, next)) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        }
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
          useNativeDriver: false,
        }).start();
      })
      .onStart(() => confirm())
      .onFinalize(() => {
        hold.stopAnimation();
        if (!doneRef.current) Animated.timing(hold, { toValue: 0, duration: 120, useNativeDriver: false }).start();
      });

    // Whichever starts first wins: moving the finger is a slide, holding
    // still is a long-press.
    return Gesture.Race(pan, longPress);
  }, [x, hold]);

  const fill = tone === "dark" ? colors.surfaceDark : colors.primary[500];

  if (screenReader) {
    return (
      <View style={styles.inset}>
        <Button label={label} variant={tone === "dark" ? "neutral" : "primary"} size="lg" onPress={onConfirm} />
      </View>
    );
  }

  const textOpacity = x.interpolate({
    inputRange: [0, Math.max(1, travelRef.current * 0.6)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });
  const holdWidth = hold.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <View style={styles.inset}>
      <View
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
        style={[styles.track, { backgroundColor: withAlpha(fill, 0.12) }]}
      >
        <Animated.View style={[styles.holdFill, { width: holdWidth, backgroundColor: withAlpha(fill, 0.18) }]} />
        <Animated.View style={[styles.label, { opacity: textOpacity }]} pointerEvents="none">
          <Text variant="bodyMedium" style={[styles.labelText, { color: fill }]} numberOfLines={1}>
            {label}
          </Text>
          <Text variant="caption" style={{ color: withAlpha(fill, 0.7) }} numberOfLines={1}>
            Slide, or hold the arrow
          </Text>
        </Animated.View>
        <GestureDetector gesture={gesture}>
          <Animated.View
            accessible
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityHint="Slide right, or hold for one second"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={[
              styles.knob,
              { backgroundColor: checked ? colors.primary[500] : fill, transform: [{ translateX: x }] },
            ]}
          >
            <Ionicons name={checked ? "checkmark" : "chevron-forward"} size={26} color={colors.white} />
          </Animated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { marginHorizontal: EDGE_INSET },
  track: {
    height: KNOB + PAD * 2,
    borderRadius: radii.full,
    padding: PAD,
    justifyContent: "center",
    overflow: "hidden",
  },
  holdFill: { position: "absolute", left: 0, top: 0, bottom: 0 },
  label: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: KNOB + spacing.md,
    paddingRight: spacing.lg,
  },
  labelText: { fontWeight: typography.weight.bold },
  knob: {
    width: KNOB,
    height: KNOB,
    borderRadius: radii.full,
    alignItems: "center",
    justifyContent: "center",
  },
});
