import { useRouter } from "expo-router";
import { useState } from "react";
import {
  GHANA_PHONE_EXAMPLE,
  isOtpCooldown,
  isTransientRequestFailure,
  normalizeGhanaPhone,
  retryAfterSecondsOf,
} from "@rida/shared";
import { requestOtp } from "../api";
import { Button, PhoneInput } from "../../design";
import { errorMessage, errorStatus } from "../errorMessage";
import { AuthPage } from "./AuthPage";

/**
 * "What's your number?" (docs/mockups/02-rider-phone.png), both apps. One
 * entry for everyone: the code is asked for the same way whether or not the
 * number has an account (purpose LOGIN, which the server never looks up), so
 * nothing here says whether a number is registered. The code screen finds
 * out, after the code is right.
 */
export function PhoneScreen() {
  const router = useRouter();
  // The 9 digits after the fixed +233 (PhoneInput reads typed and pasted numbers).
  const [digits, setDigits] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendCode() {
    if (!digits) {
      setError("Enter your phone number.");
      return;
    }
    // The shared parser (the server's too) checks the whole number, so a
    // short one is refused here, before it leaves the phone.
    const phone = normalizeGhanaPhone(`+233${digits}`);
    if (!phone) {
      setError(GHANA_PHONE_EXAMPLE);
      return;
    }
    setError(null);
    setSending(true);
    try {
      await requestOtp(phone, "LOGIN");
      router.push({ pathname: "/auth/otp", params: { phone } });
    } catch (err) {
      if (isOtpCooldown(err)) {
        // A code went to this number under a minute ago — usually this
        // "Send code" timing out earlier and then going through. Not a limit:
        // the code screen, counting down to when a new one can be sent.
        router.push({
          pathname: "/auth/otp",
          params: { phone, sent: "earlier", resendIn: String(retryAfterSecondsOf(err) ?? 60) },
        });
      } else if (isTransientRequestFailure({ status: errorStatus(err) ?? null })) {
        // No answer (a server waking up, a slow network): the code may well be
        // on its way. Never "Something went wrong" — and a retry here would only
        // meet the one-a-minute cooldown.
        router.push({ pathname: "/auth/otp", params: { phone, sent: "unsure" } });
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <AuthPage
      title="What's your number?"
      body="We'll text you a code. New here? We'll set up your account next."
      onBack={() => (router.canGoBack() ? router.back() : router.replace("/auth/welcome"))}
      footer={<Button label="Send code" loading={sending} onPress={() => void sendCode()} />}
    >
      <PhoneInput
        digits={digits}
        onChangeDigits={(next) => {
          setDigits(next);
          setError(null);
        }}
        autoFocus
        helper="You can paste 054… or +233… too."
        error={error ?? undefined}
        onSubmitEditing={() => void sendCode()}
      />
    </AuthPage>
  );
}
