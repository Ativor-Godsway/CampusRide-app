import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { View, StyleSheet } from "react-native";
import { useAuth } from "../AuthContext";
import { verifyOtp, type OtpPurpose } from "../api";
import { Button, Screen, Input, colors, radii, spacing, typography } from "../../design";
import { errorMessage } from "../errorMessage";
import { AuthHero } from "./AuthHero";

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
    <Screen scroll noPadding edges={["top"]}>
      <AuthHero compact title="Verify your number" subtitle={`We sent a 6-digit code to ${phone}`} onBack={() => router.back()} />
      <View style={styles.panel}>
        <Input
          label="Verification code"
          placeholder="000000"
          keyboardType="number-pad"
          maxLength={6}
          doneAccessory
          value={code}
          onChangeText={setCode}
          error={error ?? undefined}
          style={styles.codeInput}
        />

        <Button label="Continue" loading={isSubmitting} onPress={() => void handleVerify()} />
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
  codeInput: {
    fontFamily: typography.fontFamily.mono,
    fontSize: 24,
    fontWeight: typography.weight.bold,
    textAlign: "center",
    letterSpacing: 8,
  },
});
