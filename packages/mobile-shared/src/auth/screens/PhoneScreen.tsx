import { useRouter } from "expo-router";
import { useState } from "react";
import { View, StyleSheet } from "react-native";
import { requestOtp } from "../api";
import { Button, Screen, Text, Input, spacing } from "../../design";
import { errorMessage } from "../errorMessage";

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
    <Screen edges={["top", "bottom"]} style={styles.container}>
      <View style={styles.intro}>
        <Text variant="display" color="primary">
          CampusRide
        </Text>
        <Text variant="body" color="muted" style={styles.subtitle}>
          Enter your phone number to continue
        </Text>
      </View>

      <Input
        placeholder="+233 ..."
        keyboardType="phone-pad"
        autoComplete="tel"
        value={phone}
        onChangeText={setPhone}
        error={error ?? undefined}
      />

      <View style={styles.actions}>
        <Button label="Log in" loading={isSubmitting} onPress={() => void handleContinue("LOGIN")} />
        <Button
          label="Sign up"
          variant="secondary"
          loading={isSubmitting}
          onPress={() => void handleContinue("SIGNUP")}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    justifyContent: "center",
  },
  intro: {
    marginBottom: spacing["3xl"],
    alignItems: "center",
  },
  subtitle: {
    marginTop: spacing.sm,
    textAlign: "center",
  },
  actions: {
    gap: spacing.md,
  },
});
