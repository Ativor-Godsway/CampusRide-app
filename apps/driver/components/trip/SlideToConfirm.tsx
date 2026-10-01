import { useEffect, useRef, useState } from "react";
import { Animated, PanResponder, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text, colors, radii, spacing, typography, withAlpha } from "@rida/mobile-shared";

const KNOB = 56;
const PAD = 4;
/** How far (as a share of the track) the knob must travel to count. */
const COMPLETE_AT = 0.85;

/**
 * "Slide: Ama picked up". A slide instead of a button so a pocket tap or a
 * brushed thumb can't end a rider's trip. Completes at 85% of the track and
 * fires at once (the action is optimistic — see lib/tripActions); never shows
 * a spinner.
 *
 * Screen readers can't drag, so the control also exposes a single
 * "activate" action (double-tap with VoiceOver / TalkBack).
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
  const [width, setWidth] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const maxRef = useRef(0);
  maxRef.current = Math.max(0, width - KNOB - PAD * 2);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  // A new label is a new action: put the knob back.
  useEffect(() => {
    x.setValue(0);
  }, [label, x]);

  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 4,
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => x.setValue(Math.min(Math.max(0, g.dx), maxRef.current)),
      onPanResponderRelease: (_e, g) => {
        const max = maxRef.current;
        if (max > 0 && g.dx >= max * COMPLETE_AT) {
          Animated.timing(x, { toValue: max, duration: 80, useNativeDriver: false }).start(() => confirmRef.current());
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: false }).start(),
    }),
  ).current;

  const fill = tone === "dark" ? colors.surfaceDark : colors.primary[500];
  const textOpacity = x.interpolate({
    inputRange: [0, Math.max(1, maxRef.current * 0.6)],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.track, { backgroundColor: withAlpha(fill, 0.12) }]}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityHint="Slide right to confirm, or double-tap"
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === "activate") onConfirm();
      }}
    >
      <Animated.View style={[styles.label, { opacity: textOpacity }]} pointerEvents="none">
        <Text variant="bodyMedium" style={[styles.labelText, { color: fill }]} numberOfLines={1}>
          {label}
        </Text>
      </Animated.View>
      <Animated.View
        {...responder.panHandlers}
        style={[styles.knob, { backgroundColor: fill, transform: [{ translateX: x }] }]}
      >
        <Ionicons name="chevron-forward" size={26} color={colors.white} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: KNOB + PAD * 2,
    borderRadius: radii.full,
    padding: PAD,
    justifyContent: "center",
    overflow: "hidden",
  },
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
