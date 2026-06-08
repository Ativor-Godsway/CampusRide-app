import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View, StyleSheet } from "react-native";
import { useAuth } from "../AuthContext";
import { verifyOtp, type OtpPurpose } from "../api";
import { Button, Screen, Text, Input, spacing } from "../../design";
import { errorMessage } from "../errorMessage";

/** OTP entry — second step of the auth flow, shared by both apps. */
export function OtpScreen() {
  const router = useRouter();
  const { completeLogin } = useAuth();
  const { phone, purpose } = useLocalSearchParams<{ phone: string; purpose: OtpPurpose }>();
  const [code, setCode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleVerify() {
    if (code.length !== 6) {
      setError("Enter the 6-digit code");
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      const { verifiedToken } = await verifyOtp(phone, code, purpose);

      if (purpose === "SIGNUP") {
        router.push({ pathname: "/auth/signup", params: { phone, verifiedToken } });
      } else {
        await completeLogin({ phone, verifiedToken });
        router.replace("/");
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Screen edges={["top", "bottom"]} style={styles.container}>
      <View style={styles.intro}>
        <Text variant="h1">Enter the code</Text>
        <Text variant="body" color="muted" style={styles.subtitle}>
          We sent a 6-digit code to {phone}
        </Text>
      </View>

      <Input
        placeholder="000000"
        keyboardType="number-pad"
        maxLength={6}
        value={code}
        onChangeText={setCode}
        error={error ?? undefined}
        style={styles.codeInput}
      />

      <Button label="Continue" loading={isSubmitting} onPress={() => void handleVerify()} />
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
  codeInput: {
    fontSize: 24,
    textAlign: "center",
    letterSpacing: 8,
  },
});
