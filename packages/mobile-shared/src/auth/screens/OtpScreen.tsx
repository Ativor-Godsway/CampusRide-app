import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  formatGhanaPhone,
  retryAfterSecondsOf,
} from "@rida/shared";
import { useAuth } from "../AuthContext";
import { requestOtp, verifyCode } from "../api";
import { Button, Notice, OTP_VERIFIED_MS, OtpInput, Text, spacing } from "../../design";
import { errorMessage, wrongCodeMessage } from "../errorMessage";
import { AuthPage } from "./AuthPage";

/**
 * "Enter the code" (docs/mockups/03-rider-code.png), both apps. The 6th
 * digit checks it; only then does the server say whether the number has an
 * account (POST /auth/verify-code): an account is signed straight in (the
 * auth layout takes it from there), a new number goes on to the name + 18+
 * step.
 */
export function OtpScreen() {
  const router = useRouter();
  const { completeSignIn } = useAuth();
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  /** The server refused the code: the boxes shake and clear. */
  const [codeError, setCodeError] = useState<string | null>(null);
  /** Anything else (offline, too many requests): said below, the code kept. */
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // "Resend" counts down instead of letting people tap into a refusal: the
  // server sends a number one code per cooldown. A code was just sent to
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
      const result = await verifyCode(phone, entered);
      // Green for a moment, so they see it worked before the screen changes.
      setVerified(true);
      await new Promise<void>((resolve) => setTimeout(resolve, OTP_VERIFIED_MS));
      if (result.status === "newAccount") {
        router.push({ pathname: "/auth/signup", params: { phone, verifiedToken: result.verifiedToken } });
      } else {
        await completeSignIn(result);
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

  async function resend() {
    setError(null);
    setCodeError(null);
    setNotice(null);
    setIsResending(true);
    try {
      await requestOtp(phone, "LOGIN");
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

  const back = () => (router.canGoBack() ? router.back() : router.replace("/auth/phone"));

  return (
    <AuthPage
      title="Enter the code"
      onBack={back}
      body={
        <Text variant="body" color="secondary">
          Sent by SMS to{" "}
          <Text variant="bodyStrong" tabular>
            {formatGhanaPhone(phone)}
          </Text>
          .{" "}
          <Text
            variant="bodyStrong"
            color="brand"
            accessibilityRole="link"
            accessibilityLabel="Change the number"
            onPress={back}
          >
            Change
          </Text>
        </Text>
      }
    >
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
          onPress={() => void resend()}
        />
      </View>
    </AuthPage>
  );
}

const styles = StyleSheet.create({
  notice: {
    marginTop: spacing[4],
  },
  resend: {
    marginTop: spacing[4],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // The text button's own 8px padding: its label ends flush with the boxes.
    marginRight: -spacing[2],
  },
});
