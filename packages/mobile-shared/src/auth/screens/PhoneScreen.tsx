import { useRouter } from "expo-router";
import { useState } from "react";
import { View, StyleSheet } from "react-native";
import { GHANA_PHONE_EXAMPLE, normalizeGhanaPhone } from "@rida/shared";
import { requestOtp } from "../api";
import { Button, PhoneInput, Screen, Text, colors, radii, spacing } from "../../design";
import { errorMessage } from "../errorMessage";
import { AuthHero } from "./AuthHero";

export interface PhoneScreenProps {
  /** Tag beside the wordmark — the driver app passes "DRIVER". */
  badge?: string;
  title?: string;
  subtitle?: string;
  signupLabel?: string;
}

/** Phone entry — start of the auth flow for both rider and driver apps. */
export function PhoneScreen({
  badge,
  title = "Campus rides, on demand",
  subtitle = "Fast, affordable trips around campus — book in seconds.",
  signupLabel = "Create an account",
}: PhoneScreenProps = {}) {
  const router = useRouter();
  // The 9 digits after the fixed +233 (PhoneInput reads typed and pasted numbers).
  const [digits, setDigits] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue(purpose: "SIGNUP" | "LOGIN") {
    if (!digits) {
      setError("Enter your phone number");
      return;
    }
    // The shared parser (the server's too) checks the whole number, so a
    // short one is refused here, before it leaves the phone.
    const canonical = normalizeGhanaPhone(`+233${digits}`);
    if (!canonical) {
      setError(GHANA_PHONE_EXAMPLE);
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await requestOtp(canonical, purpose);
      router.push({ pathname: "/auth/otp", params: { phone: canonical, purpose } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen scroll noPadding edges={["top"]}>
      <AuthHero badge={badge} title={title} subtitle={subtitle} />
      <View style={styles.panel}>
        <PhoneInput digits={digits} onChangeDigits={setDigits} error={error ?? undefined} />

        <View style={styles.actions}>
          <Button label="Log in" loading={isSubmitting} onPress={() => void handleContinue("LOGIN")} />
          <Button
            label={signupLabel}
            variant="secondary"
            loading={isSubmitting}
            onPress={() => void handleContinue("SIGNUP")}
          />
        </View>

        <Text variant="caption" color="muted" style={styles.disclaimer}>
          By continuing you agree to CampusRide's terms and privacy policy.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    backgroundColor: colors.white,
    borderTopLeftRadius: radii["2xl"],
    borderTopRightRadius: radii["2xl"],
    marginTop: -radii["2xl"],
    paddingHorizontal: spacing.xl,
    paddingTop: spacing["2xl"],
    paddingBottom: spacing.xl,
  },
  actions: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  disclaimer: {
    marginTop: spacing.xl,
    textAlign: "center",
  },
});
