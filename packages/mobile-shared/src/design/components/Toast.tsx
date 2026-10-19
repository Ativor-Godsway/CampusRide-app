import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  type ViewProps,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radii, shadows, spacing } from "../tokens";
import { useReduceMotion } from "./Illustration";
import { Text } from "./Text";

export type ToastTone = "success" | "info" | "warning";

export interface ToastOptions {
  message: string;
  subtitle?: string;
  /** Changes only the icon colour. */
  tone?: ToastTone;
  icon?: keyof typeof Ionicons.glyphMap;
  action?: { label: string; onPress: () => void };
}

interface UseToastResult {
  /** Confirms something that already happened; a new toast replaces the current one. */
  showToast: (toast: string | ToastOptions) => void;
  /** Render as the last child of the screen's root view; it sits under the status bar. */
  toast: ReactElement | null;
}

/** How long a toast stays up. */
export const TOAST_MS = 3000;

const TONE_ICON: Record<ToastTone, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  success: { name: "checkmark-circle", color: colors.greenOnDark },
  info: { name: "information-circle", color: colors.greenOnDark },
  warning: { name: "warning", color: colors.amber400 },
};

/**
 * docs/design-system.md, "Toast": a short dark message that slides down
 * under the status bar for 3 seconds, one at a time, away from the buttons
 * at the bottom of the screen. Swipe up to dismiss; announced to screen
 * readers. Problems that need fixing use a Notice instead.
 */
export function useToast(): UseToastResult {
  const [current, setCurrent] = useState<ToastOptions | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduceMotion = useReduceMotion();

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    Animated.timing(progress, { toValue: 0, duration: 180, useNativeDriver: true }).start(
      ({ finished }) => {
        if (finished) setCurrent(null);
      },
    );
  }, [progress]);

  const showToast = useCallback(
    (next: string | ToastOptions) => {
      const options = typeof next === "string" ? { message: next } : next;
      if (timer.current) clearTimeout(timer.current);
      setCurrent(options);
      progress.setValue(0);
      Animated.timing(progress, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      AccessibilityInfo.announceForAccessibility(
        options.subtitle ? `${options.message}. ${options.subtitle}` : options.message,
      );
      timer.current = setTimeout(hide, TOAST_MS);
    },
    [progress, hide],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const toast = current ? (
    <ToastView options={current} progress={progress} reduceMotion={reduceMotion} onDismiss={hide} />
  ) : null;

  return { showToast, toast };
}

function ToastView({
  options,
  progress,
  reduceMotion,
  onDismiss,
}: {
  options: ToastOptions;
  progress: Animated.Value;
  reduceMotion: boolean;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => g.dy < -6,
      onPanResponderRelease: (_e, g) => {
        if (g.dy < -12) onDismiss();
      },
    }),
  ).current;
  const tone = TONE_ICON[options.tone ?? "success"];
  const translateY = reduceMotion
    ? 0
    : progress.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] });

  return (
    <View pointerEvents="box-none" style={[styles.layer, { top: insets.top + spacing[2] }]}>
      <Animated.View
        accessibilityRole="alert"
        style={[styles.toast, { opacity: progress, transform: [{ translateY }] }]}
        {...pan.panHandlers}
      >
        <Ionicons name={options.icon ?? tone.name} size={22} color={tone.color} />
        <View style={styles.body}>
          <Text variant="bodyStrong" color="onDark" style={styles.message}>
            {options.message}
          </Text>
          {options.subtitle ? (
            <Text variant="subhead" color="onDark2">
              {options.subtitle}
            </Text>
          ) : null}
        </View>
        {options.action ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => {
              options.action?.onPress();
              onDismiss();
            }}
          >
            <Text variant="bodyStrong" color="greenOnDark">
              {options.action.label}
            </Text>
          </Pressable>
        ) : null}
      </Animated.View>
    </View>
  );
}

export interface NoticeProps extends ViewProps {
  /** warning: amber-50 / amber-700 · error: red-50 / red-600. */
  tone?: "warning" | "error";
  /** One sentence that says how to fix it. */
  message: string;
  icon?: keyof typeof Ionicons.glyphMap;
}

/** Inline notice: stays until the problem is fixed (e.g. an out-of-area pickup). */
export function Notice({ tone = "warning", message, icon, style, ...rest }: NoticeProps) {
  const look = tone === "error" ? NOTICE.error : NOTICE.warning;
  return (
    <View
      accessibilityRole="alert"
      style={[styles.notice, { backgroundColor: look.fill }, style]}
      {...rest}
    >
      <Ionicons name={icon ?? look.icon} size={20} color={look.text} style={styles.noticeIcon} />
      <Text variant="subhead" style={[styles.noticeText, { color: look.text }]}>
        {message}
      </Text>
    </View>
  );
}

const NOTICE = {
  warning: { fill: colors.amber50, text: colors.amber700, icon: "warning-outline" },
  error: { fill: colors.red50, text: colors.red600, icon: "alert-circle-outline" },
} as const;

const styles = StyleSheet.create({
  layer: {
    position: "absolute",
    left: spacing.gutter,
    right: spacing.gutter,
    alignItems: "stretch",
    zIndex: 1000,
    elevation: 1000,
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing[3],
    backgroundColor: colors.surfaceDark,
    borderRadius: radii.md,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
    ...shadows.float,
  },
  body: {
    flex: 1,
  },
  // 15/600 in the spec.
  message: {
    fontSize: 15,
    lineHeight: 20,
  },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[2],
    borderRadius: radii.md,
    padding: spacing[3],
  },
  noticeIcon: {
    marginTop: 0,
  },
  noticeText: {
    flex: 1,
    fontWeight: "600",
  },
});
