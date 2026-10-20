import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { fonts } from "../fonts";
import { haptics } from "../haptics";
import { colors, radii, sizes, spacing } from "../tokens";
import { useReduceMotion } from "./Illustration";
import { Text } from "./Text";

export const OTP_LENGTH = 6;
/** How long the boxes show green after a right code, before the screen moves on. */
export const OTP_VERIFIED_MS = 400;
const SHAKE_MS = 300;

export interface OtpInputProps {
  /** The digits typed so far (0–6). */
  value: string;
  onChange: (code: string) => void;
  /** Called the moment the 6th digit is in: there's no Continue button. */
  onComplete?: (code: string) => void;
  /** A wrong code, said plainly ("That code didn't match. Check the SMS and try again."). */
  error?: string | null;
  /** While the code is being checked. */
  verifying?: boolean;
  /** The code was right: green for OTP_VERIFIED_MS, then the screen moves on. */
  verified?: boolean;
  autoFocus?: boolean;
}

/**
 * docs/design-system.md, "OtpInput": six digit boxes drawn from ONE hidden
 * TextInput, so iOS offers the code from Messages ("oneTimeCode") and Android
 * suggests it ("sms-otp"), and pasting six digits fills every box.
 *
 * A wrong code turns the boxes red, shakes them three times with a warning
 * haptic, then clears them and puts the cursor back in the first box.
 */
export function OtpInput({
  value,
  onChange,
  onComplete,
  error,
  verifying = false,
  verified = false,
  autoFocus = true,
}: OtpInputProps) {
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const reduceMotion = useReduceMotion();
  const shake = useRef(new Animated.Value(0)).current;
  const caret = useRef(new Animated.Value(1)).current;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Wrong code: haptic, shake, then clear and refocus.
  useEffect(() => {
    if (!error) return;
    haptics.warning();
    const clear = () => {
      onChangeRef.current("");
      input.current?.focus();
    };
    if (reduceMotion) {
      clear();
      return;
    }
    const step = SHAKE_MS / 6;
    const to = (x: number) =>
      Animated.timing(shake, { toValue: x, duration: step, useNativeDriver: true });
    Animated.sequence([to(8), to(-8), to(8), to(-8), to(8), to(0)]).start(clear);
  }, [error, reduceMotion, shake]);

  // The caret blinks in the active box (still with Reduce Motion on).
  useEffect(() => {
    if (!focused || reduceMotion) {
      caret.setValue(1);
      return;
    }
    // On and off, not a fade: half a second each.
    const flip = (to: number) =>
      Animated.timing(caret, { toValue: to, duration: 0, useNativeDriver: true });
    const blink = Animated.loop(
      Animated.sequence([Animated.delay(500), flip(0), Animated.delay(500), flip(1)]),
    );
    blink.start();
    return () => blink.stop();
  }, [focused, reduceMotion, caret]);

  const handleChange = (text: string) => {
    const digits = text.replace(/\D/g, "").slice(0, OTP_LENGTH);
    onChange(digits);
    if (digits.length === OTP_LENGTH && value.length < OTP_LENGTH) onComplete?.(digits);
  };

  const active = Math.min(value.length, OTP_LENGTH - 1);
  const tone = verified ? "verified" : error ? "error" : "normal";

  return (
    <View>
      <Animated.View style={[styles.row, { transform: [{ translateX: shake }] }]}>
        {Array.from({ length: OTP_LENGTH }, (_, i) => {
          const digit = value[i] ?? "";
          const isActive = focused && i === active && tone === "normal" && !verifying;
          return (
            <View
              key={i}
              style={[
                styles.box,
                isActive && styles.boxActive,
                tone === "error" && styles.boxError,
                tone === "verified" && styles.boxVerified,
              ]}
            >
              {digit ? (
                <Text
                  tabular
                  style={[
                    styles.digit,
                    tone === "error" && { color: colors.red600 },
                    tone === "verified" && { color: colors.green700 },
                  ]}
                >
                  {digit}
                </Text>
              ) : isActive ? (
                <Animated.View style={[styles.caret, { opacity: caret }]} />
              ) : null}
            </View>
          );
        })}
        {/* The real field, invisible, over the boxes: taps, paste and autofill land on it. */}
        <TextInput
          ref={input}
          value={value}
          onChangeText={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          maxLength={OTP_LENGTH}
          autoFocus={autoFocus}
          editable={!verifying && !verified}
          caretHidden
          contextMenuHidden={false}
          selectTextOnFocus={false}
          accessibilityLabel="Verification code, 6 digits"
          accessibilityHint="The code we sent you by SMS"
          style={styles.hidden}
        />
      </Animated.View>
      {error ? (
        <View style={styles.message} accessibilityLiveRegion="polite">
          <Ionicons
            name="alert-circle"
            size={16}
            color={colors.red600}
            style={styles.messageIcon}
          />
          <Text variant="subhead" color="danger" style={styles.messageText}>
            {error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: spacing[2],
  },
  box: {
    flex: 1,
    height: sizes.controlLg,
    borderRadius: radii.md,
    backgroundColor: colors.surface2,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  boxActive: {
    backgroundColor: colors.surface,
    borderColor: colors.green500,
  },
  boxError: {
    backgroundColor: colors.red50,
    borderColor: colors.red600,
  },
  boxVerified: {
    backgroundColor: colors.green50,
    borderColor: colors.green50,
  },
  // 26/800, tabular (the spec's OTP digits).
  digit: {
    fontFamily: fonts.extrabold,
    fontSize: 26,
    lineHeight: 32,
    color: colors.ink,
  },
  caret: {
    width: 2,
    height: 26,
    borderRadius: 1,
    backgroundColor: colors.ink,
  },
  hidden: {
    ...StyleSheet.absoluteFill,
    color: "transparent",
    opacity: 0.02,
  },
  message: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing[1],
    marginTop: spacing[3],
  },
  messageIcon: {
    marginTop: 2,
  },
  messageText: {
    flex: 1,
  },
});
