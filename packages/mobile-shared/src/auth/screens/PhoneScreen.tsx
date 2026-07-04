import { useRouter } from "expo-router";
import { useState } from "react";
import { View, StyleSheet } from "react-native";
import { requestOtp } from "../api";
import { Button, Screen, Text, Input, colors, radii, spacing } from "../../design";
import { errorMessage } from "../errorMessage";
import { AuthHero } from "./AuthHero";

/** Phone entry — start of the auth flow for both rider and driver apps. */
export function PhoneScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleContinue(purpose: "SIGNUP" | "LOGIN") {
    if (!phone) {
      setError("Enter your phone number");
      return;
    }

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
    <Screen scroll noPadding edges={["top"]}>
      <AuthHero
        title="Campus rides, on demand"
        subtitle="Fast, affordable trips around campus — book in seconds."
      />
      <View style={styles.panel}>
        <Input
          label="Phone number"
          placeholder="+233 ..."
          keyboardType="phone-pad"
          autoComplete="tel"
          doneAccessory
          value={phone}
          onChangeText={setPhone}
          error={error ?? undefined}
        />

        <View style={styles.actions}>
          <Button label="Log in" loading={isSubmitting} onPress={() => void handleContinue("LOGIN")} />
          <Button
            label="Create an account"
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
