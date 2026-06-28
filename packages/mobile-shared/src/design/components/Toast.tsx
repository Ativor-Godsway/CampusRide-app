import { useCallback, useRef, useState, type ReactElement } from "react";
import { Animated, StyleSheet } from "react-native";
import { colors, radii, spacing, typography } from "../tokens";
import { Text } from "./Text";

interface UseToastResult {
  /** Show a brief, non-blocking message that auto-dismisses. */
  showToast: (message: string) => void;
  /** Render this inside a flex:1 container; it pins to the viewport bottom. */
  toast: ReactElement | null;
}

/**
 * Minimal, non-blocking toast — a fading pill anchored to the bottom of its
 * container. Pure RN Animated (Expo Go safe), tokens only. Render the returned
 * `toast` node as the last child of a flex:1 wrapper so it overlays content.
 */
export function useToast(): UseToastResult {
  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback(
    (next: string) => {
      if (timer.current) clearTimeout(timer.current);
      setMessage(next);
      Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
          ({ finished }) => {
            if (finished) setMessage(null);
          },
        );
      }, 2400);
    },
    [opacity],
  );

  const toast = message ? (
    <Animated.View pointerEvents="none" style={[styles.wrap, { opacity }]}>
      <Text variant="bodySmall" style={styles.text}>
        {message}
      </Text>
    </Animated.View>
  ) : null;

  return { showToast, toast };
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    alignItems: "center",
    backgroundColor: colors.surfaceDark,
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: {
    color: colors.white,
    fontWeight: typography.weight.medium,
    textAlign: "center",
  },
});
