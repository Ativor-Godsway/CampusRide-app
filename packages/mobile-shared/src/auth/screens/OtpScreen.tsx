import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import {
  OTP_RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  formatGhanaPhone,
  isOtpCooldown,
  isTransientRequestFailure,
  otpCooldownMessage,
  retryAfterSecondsOf,
} from "@rida/shared";
import { useAuth } from "../AuthContext";
import { requestOtp, verifyCode } from "../api";
import { Button, Notice, OTP_VERIFIED_MS, OtpInput, Text, spacing } from "../../design";
import { errorMessage, errorStatus, wrongCodeMessage } from "../errorMessage";
import { AuthPage } from "./AuthPage";

/** "Send code" got no answer: the code may still have gone out. */
const UNSURE_NOTICE = "If you got a code, enter it here.";

/**
 * What the screen says first, from how the phone screen got here (`sent`):
 * "unsure" — Send code timed out; "earlier" — a code went out under a minute
 * ago (the server's cooldown). Otherwise the usual "Didn't get it?".
 */
function arrivalNotice(sent: string | undefined): string | null {
  if (sent === "unsure") return UNSURE_NOTICE;
  if (sent === "earlier") return "We sent you a code a moment ago. If you got it, enter it here.";
  return null;
}

/** Seconds before Resend: the server's wait when it gave one, else a full cooldown. */
function initialWaitSeconds(resendIn: string | undefined): number {
  const n = Number(resendIn);
  return Number.isFinite(n) && n > 0 ? Math.min(n, OTP_RESEND_COOLDOWN_SECONDS) : OTP_RESEND_COOLDOWN_SECONDS;
}

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
  const params = useLocalSearchParams<{ phone: string; sent?: string; resendIn?: string }>();
  const { phone } = params;
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  /** The server refused the code: the boxes shake and clear. */
  const [codeError, setCodeError] = useState<string | null>(null);
  /** Anything else (offline, too many requests): said below, the code kept. */
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(() => arrivalNotice(params.sent));

  // "Resend" counts down instead of letting people tap into a refusal: the
  // server sends a number one code per cooldown. A code was just sent to
  // reach this screen, so the countdown starts full.
  const [resendAt, setResendAt] = useState(() => Date.now() + initialWaitSeconds(params.resendIn) * 1000);
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
      if (isTransientRequestFailure({ status: errorStatus(err) ?? null })) {
        // No answer: it may have gone through. Count down as if it did.
        setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
        setNotice(UNSURE_NOTICE);
        return;
      }
      // Too many codes for this number: count down to when the server will
      // send the next one, however long that is. The cooldown says so as a
      // short wait ("Wait 0:45 before asking for a new code.").
      const wait = retryAfterSecondsOf(err);
      if (wait !== null) setResendAt(Date.now() + wait * 1000);
      setError(isOtpCooldown(err) ? otpCooldownMessage(wait ?? OTP_RESEND_COOLDOWN_SECONDS) : errorMessage(err));
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
