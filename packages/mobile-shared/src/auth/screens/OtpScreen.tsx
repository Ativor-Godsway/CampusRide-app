import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { OTP_RESEND_COOLDOWN_SECONDS, formatCountdown, retryAfterSecondsOf } from "@rida/shared";
import { useAuth } from "../AuthContext";
import { requestOtp, verifyOtp, type OtpPurpose } from "../api";
import { Button, Screen, Input, Text, colors, radii, spacing, typography } from "../../design";
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
  const [notice, setNotice] = useState<string | null>(null);

  // "Resend code" counts down instead of letting people tap into a refusal:
  // the server sends a number one code per cooldown. A code was just sent to
  // reach this screen, so the countdown starts full.
  const [resendAt, setResendAt] = useState(() => Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
  const [now, setNow] = useState(() => Date.now());
  const [isResending, setIsResending] = useState(false);
  const secondsLeft = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (secondsLeft === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft]);

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

  async function handleResend() {
    setError(null);
    setNotice(null);
    setIsResending(true);
    try {
      await requestOtp(phone, purpose);
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setNotice("We sent you a new code.");
    } catch (err) {
      // Too many codes for this number: count down to when the server will
      // send the next one, however long that is.
      const wait = retryAfterSecondsOf(err);
      if (wait !== null) setResendAt(Date.now() + wait * 1000);
      setError(errorMessage(err));
    } finally {
      setNow(Date.now());
      setIsResending(false);
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

        <View style={styles.resend}>
          {notice ? (
            <Text variant="caption" color="muted" style={styles.notice}>
              {notice}
            </Text>
          ) : null}
          <Button
            label={secondsLeft > 0 ? `Resend code in ${formatCountdown(secondsLeft)}` : "Resend code"}
            variant="ghost"
            disabled={secondsLeft > 0}
            loading={isResending}
            onPress={() => void handleResend()}
          />
        </View>
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
  resend: {
    marginTop: spacing.md,
    gap: spacing.xs,
  },
  notice: {
    textAlign: "center",
  },
});
