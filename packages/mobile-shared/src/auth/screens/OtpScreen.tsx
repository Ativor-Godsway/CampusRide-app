import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import { OTP_RESEND_COOLDOWN_SECONDS, formatCountdown, formatGhanaPhone, retryAfterSecondsOf } from "@rida/shared";
import { useAuth } from "../AuthContext";
import { requestOtp, verifyOtp, type OtpPurpose } from "../api";
import { Button, Notice, OTP_VERIFIED_MS, OtpInput, Screen, Text, colors, radii, spacing } from "../../design";
import { errorMessage, wrongCodeMessage } from "../errorMessage";
import { AuthHero } from "./AuthHero";

/** OTP entry — second step of the auth flow, shared by both apps. */
export function OtpScreen() {
  const router = useRouter();
  const { completeLogin } = useAuth();
  const { phone, purpose } = useLocalSearchParams<{ phone: string; purpose: OtpPurpose }>();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  /** The server refused the code: the boxes shake and clear. */
  const [codeError, setCodeError] = useState<string | null>(null);
  /** Anything else (offline, too many requests): said below, the code kept. */
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

  /** Called the moment the 6th digit is in: there is no Continue button. */
  async function verify(entered: string) {
    setError(null);
    setCodeError(null);
    setVerifying(true);
    try {
      const { verifiedToken } = await verifyOtp(phone, entered, purpose);
      // Green for a moment, so the rider sees it worked before the screen changes.
      setVerified(true);
      await new Promise<void>((resolve) => setTimeout(resolve, OTP_VERIFIED_MS));

      if (purpose === "SIGNUP") {
        router.push({ pathname: "/auth/signup", params: { phone, verifiedToken } });
      } else {
        // Signed in: the auth layout (AuthStackLayout) takes it from here,
        // replacing these screens with the start screen.
        await completeLogin({ phone, verifiedToken });
      }
    } catch (err) {
      setVerified(false);
      const wrong = wrongCodeMessage(err);
      if (wrong) setCodeError(wrong);
      else setError(errorMessage(err));
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend() {
    setError(null);
    setCodeError(null);
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
      <AuthHero compact title="Verify your number" subtitle={`We sent a 6-digit code to ${formatGhanaPhone(phone)}`} onBack={() => router.back()} />
      <View style={styles.panel}>
        <OtpInput
          value={code}
          onChange={(next) => {
            setCode(next);
            // The wrong-code message stays until they start typing again.
            if (next) setCodeError(null);
          }}
          onComplete={(entered) => void verify(entered)}
          error={codeError}
          verifying={verifying}
          verified={verified}
        />

        {error ? <Notice tone="error" message={error} style={styles.notice} /> : null}

        <View style={styles.resend}>
          <Text variant="subhead" color="secondary">
            {notice ?? "Didn't get it?"}
          </Text>
          <Button
            label={secondsLeft > 0 ? `Resend in ${formatCountdown(secondsLeft)}` : "Resend code"}
            variant="text"
            size="md"
            fullWidth={false}
            disabled={secondsLeft > 0 || verifying}
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
  resend: {
    marginTop: spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  notice: {
    marginTop: spacing[4],
  },
});
