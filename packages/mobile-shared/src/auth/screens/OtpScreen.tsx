import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Animated, {
  cancelAnimation,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useAuth } from "../AuthContext";
import { requestOtp, verifyOtp, type OtpPurpose } from "../api";
import {
  Caret,
  Keypad,
  Screen,
  Text,
  brand,
  border,
  colors,
  haptics,
  motion,
  radii,
  spacing,
  status,
  surface,
} from "../../design";
import { errorMessage } from "../errorMessage";
import { formatLocalNumber } from "./PhoneScreen";

const CODE_LENGTH = 6;
const RESEND_SECONDS = 30;

type VerifyState = "entry" | "verifying" | "success";

/** "0551234567" → "+233 55 123 4567" for display. */
function formatIntl(phone: string): string {
  const local = phone.startsWith("0") ? phone.slice(1) : phone;
  return `+233 ${formatLocalNumber(local)}`;
}

function formatCountdown(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One code box — digit scale-pops in; border tracks active/error; bg flashes brand tint on success. */
function DigitBox({
  char,
  active,
  hasError,
  flash,
}: {
  char: string | undefined;
  active: boolean;
  hasError: boolean;
  flash: SharedValue<number>;
}) {
  const pop = useSharedValue(1);

  useEffect(() => {
    if (char) {
      pop.value = 0.6;
      pop.value = withSpring(1, motion.spring.snappy);
    }
  }, [char, pop]);

  const boxStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(flash.value, [0, 1], [surface.raised, brand.tint]),
  }));
  const digitStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pop.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.box,
        active && styles.boxActive,
        hasError && styles.boxError,
        boxStyle,
      ]}
    >
      {char ? (
        <Animated.Text style={[styles.boxDigit, digitStyle]}>{char}</Animated.Text>
      ) : active ? (
        <Caret height={24} />
      ) : null}
    </Animated.View>
  );
}

/** OTP entry — second step of the auth flow, shared by both apps. Auto-verifies the instant the 6th digit lands. */
export function OtpScreen() {
  const router = useRouter();
  const { completeLogin } = useAuth();
  const { phone, purpose } = useLocalSearchParams<{ phone: string; purpose: OtpPurpose }>();

  const [code, setCode] = useState("");
  const [verifyState, setVerifyState] = useState<VerifyState>("entry");
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(RESEND_SECONDS);
  const inFlight = useRef(false);

  const shakeX = useSharedValue(0);
  const flash = useSharedValue(0);
  const pulse = useSharedValue(1);

  // Resend countdown — 1s timeout chain, self-clearing on unmount.
  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  // Cancel loops if the screen unmounts mid-verify.
  useEffect(
    () => () => {
      cancelAnimation(pulse);
      cancelAnimation(shakeX);
      cancelAnimation(flash);
    },
    [pulse, shakeX, flash],
  );

  async function verify(fullCode: string) {
    // One in-flight verify max — auto-submit must never double-fire.
    if (inFlight.current) return;
    inFlight.current = true;
    setVerifyState("verifying");
    setError(null);
    pulse.value = withRepeat(withTiming(0.55, { duration: 450 }), -1, true);

    try {
      const { verifiedToken } = await verifyOtp(phone, fullCode, purpose);
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: motion.duration.fast });
      setVerifyState("success");
      flash.value = withTiming(1, { duration: motion.duration.fast });
      haptics.success();

      // Brief beat so the tint flash reads, then navigate exactly as before.
      setTimeout(() => {
        if (purpose === "SIGNUP") {
          router.push({ pathname: "/auth/signup", params: { phone, verifiedToken } });
          // Re-arm in case the user backs out of signup to this screen.
          setTimeout(() => {
            flash.value = 0;
            setCode("");
            setVerifyState("entry");
            inFlight.current = false;
          }, 600);
        } else {
          void completeLogin({ phone, verifiedToken })
            .then(() => router.replace("/"))
            .catch((err) => {
              flash.value = 0;
              setCode("");
              setVerifyState("entry");
              setError(errorMessage(err));
              inFlight.current = false;
            });
        }
      }, 350);
    } catch (err) {
      cancelAnimation(pulse);
      pulse.value = withTiming(1, { duration: motion.duration.fast });
      haptics.error();
      setError(errorMessage(err));
      setVerifyState("entry");
      shakeX.value = withSequence(
        withTiming(-8, { duration: 50 }),
        withTiming(8, { duration: 50 }),
        withTiming(-8, { duration: 50 }),
        withTiming(8, { duration: 50 }),
        withTiming(-8, { duration: 50 }),
        withTiming(8, { duration: 50 }),
        withTiming(-8, { duration: 50 }),
        withTiming(0, { duration: 50 }),
      );
      setTimeout(() => {
        setCode("");
        inFlight.current = false;
      }, 400);
    }
  }

  // Auto-submit the instant the 6th digit lands.
  useEffect(() => {
    if (code.length === CODE_LENGTH && verifyState === "entry") {
      void verify(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, verifyState]);

  function handleResend() {
    setError(null);
    setResendIn(RESEND_SECONDS);
    void requestOtp(phone, purpose).catch((err) => setError(errorMessage(err)));
  }

  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
    opacity: pulse.value,
  }));

  const hasError = error !== null && verifyState === "entry";
  const keypadDisabled = verifyState !== "entry";

  return (
    <Screen noKeyboardHandling>
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Back"
        style={styles.backButton}
      >
        <Ionicons name="chevron-back" size={22} color={colors.ink[700]} />
      </Pressable>

      <Text variant="display">Enter the code</Text>
      <View style={styles.subtitleRow}>
        <Text variant="body" color="muted">
          Sent to {formatIntl(phone)} ·{" "}
        </Text>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Edit phone number"
          hitSlop={12}
        >
          <Text variant="body" color="primary" style={styles.editLink}>
            Edit
          </Text>
        </Pressable>
      </View>

      <Animated.View style={[styles.boxRow, rowStyle]}>
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <DigitBox
            key={i}
            char={code[i]}
            active={verifyState === "entry" && i === code.length}
            hasError={hasError}
            flash={flash}
          />
        ))}
      </Animated.View>

      {hasError ? (
        <Text variant="bodySmall" color="error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.resendRow}>
        {resendIn > 0 ? (
          <Text variant="bodySmall" color="muted">
            Resend code in <Text variant="mono" style={styles.countdown}>{formatCountdown(resendIn)}</Text>
          </Text>
        ) : (
          <Pressable onPress={handleResend} accessibilityRole="button" hitSlop={12}>
            <Text variant="bodySmall" color="primary">
              Resend code
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.spacer} />

      <Keypad
        onDigit={(d) => {
          if (keypadDisabled) return;
          setError(null);
          setCode((c) => (c.length < CODE_LENGTH ? c + d : c));
        }}
        onBackspace={() => setCode((c) => c.slice(0, -1))}
        onClearAll={() => setCode("")}
        disabled={keypadDisabled}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  backButton: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: border.subtle,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  editLink: {
    fontWeight: "600",
  },
  boxRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  box: {
    flex: 1,
    aspectRatio: 0.82,
    maxHeight: 68,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    borderColor: border.subtle,
    alignItems: "center",
    justifyContent: "center",
  },
  boxActive: {
    borderColor: brand.primary,
  },
  boxError: {
    borderColor: status.error,
  },
  boxDigit: {
    fontSize: 24,
    fontWeight: "700",
    color: colors.ink[900],
  },
  error: {
    marginTop: spacing.md,
  },
  resendRow: {
    marginTop: spacing.lg,
    minHeight: 44,
    justifyContent: "center",
  },
  countdown: {
    fontSize: 14,
  },
  spacer: {
    flex: 1,
    minHeight: spacing.lg,
  },
});
