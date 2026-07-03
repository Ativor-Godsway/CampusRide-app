import { useRouter, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { requestOtp, type OtpPurpose } from "../api";
import {
  Button,
  Caret,
  Keypad,
  Screen,
  Text,
  brand,
  border,
  colors,
  ink,
  radii,
  spacing,
  surface,
} from "../../design";
import { errorMessage } from "../errorMessage";

/** Local Ghana number without the leading 0 — 9 digits, formatted "XX XXX XXXX". */
const LOCAL_DIGITS = 9;

export function formatLocalNumber(digits: string): string {
  const a = digits.slice(0, 2);
  const b = digits.slice(2, 5);
  const c = digits.slice(5, 9);
  return [a, b, c].filter(Boolean).join(" ");
}

/** Phone entry — start of the auth flow for both rider and driver apps. Keypad-driven; the system keyboard never opens here. */
export function PhoneScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ purpose?: string }>();
  const [purpose, setPurpose] = useState<OtpPurpose>(params.purpose === "SIGNUP" ? "SIGNUP" : "LOGIN");
  const [digits, setDigits] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue = digits.length === LOCAL_DIGITS && !isSubmitting;

  function handleDigit(digit: string) {
    setError(null);
    setDigits((current) => {
      if (current.length >= LOCAL_DIGITS) return current;
      // The +233 prefix chip already carries the leading 0 — swallow a habitual one.
      if (current.length === 0 && digit === "0") return current;
      return current + digit;
    });
  }

  async function handleContinue() {
    if (!canContinue) return;
    // Canonical Moolre local format: 0XXXXXXXXX.
    const phone = `0${digits}`;
    setError(null);
    setIsSubmitting(true);
    try {
      await requestOtp(phone, purpose);
      router.push({ pathname: "/auth/otp", params: { phone, purpose } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen noKeyboardHandling>
      {router.canGoBack() ? (
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={22} color={colors.ink[700]} />
        </Pressable>
      ) : null}

      <Text variant="display">What's your number?</Text>
      <Text variant="body" color="muted" style={styles.subtitle}>
        We'll text a 6-digit code to verify it's really you.
      </Text>

      <View style={[styles.numberRow, digits.length > 0 && styles.numberRowActive]}>
        <View style={styles.prefixChip}>
          <Text variant="headline">GH +233</Text>
        </View>
        <View style={styles.numberField}>
          {digits.length > 0 ? (
            <Text variant="title" style={styles.numberText}>
              {formatLocalNumber(digits)}
            </Text>
          ) : (
            <Text variant="title" style={styles.numberPlaceholder}>
              XX XXX XXXX
            </Text>
          )}
          <Caret height={26} />
        </View>
      </View>

      <Text variant="caption" color="subtle" style={styles.smsNote}>
        Standard SMS rates may apply.
      </Text>

      {error ? (
        <Text variant="bodySmall" color="error" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <View style={styles.spacer} />

      <Keypad
        onDigit={handleDigit}
        onBackspace={() => setDigits((c) => c.slice(0, -1))}
        onClearAll={() => setDigits("")}
        disabled={isSubmitting}
      />

      <View style={styles.footer}>
        <Button label="Continue" loading={isSubmitting} disabled={!canContinue} onPress={() => void handleContinue()} />
        <Pressable
          onPress={() => {
            setError(null);
            setPurpose((p) => (p === "LOGIN" ? "SIGNUP" : "LOGIN"));
          }}
          accessibilityRole="button"
          style={styles.switchLink}
        >
          <Text variant="bodySmall" color="muted">
            {purpose === "LOGIN" ? "New to CampusRide? " : "Already have an account? "}
            <Text variant="bodySmall" color="primary">
              {purpose === "LOGIN" ? "Create an account" : "Log in"}
            </Text>
          </Text>
        </Pressable>
      </View>
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
  subtitle: {
    marginTop: spacing.xs,
    marginBottom: spacing.xl,
  },
  numberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: surface.raised,
    borderWidth: 1.5,
    borderColor: border.subtle,
    borderRadius: radii.md,
    padding: spacing.sm,
    minHeight: 64,
  },
  numberRowActive: {
    borderColor: brand.primary,
  },
  prefixChip: {
    backgroundColor: surface.sunken,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    alignSelf: "stretch",
    justifyContent: "center",
  },
  numberField: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
  },
  numberText: {
    letterSpacing: 1,
  },
  numberPlaceholder: {
    letterSpacing: 1,
    color: ink.tertiary,
  },
  smsNote: {
    marginTop: spacing.sm,
  },
  error: {
    marginTop: spacing.sm,
  },
  spacer: {
    flex: 1,
    minHeight: spacing.lg,
  },
  footer: {
    marginTop: spacing.md,
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  switchLink: {
    alignSelf: "center",
    minHeight: 44,
    justifyContent: "center",
  },
});
