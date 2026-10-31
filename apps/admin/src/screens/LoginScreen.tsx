import { useEffect, useState } from "react";
import {
  GHANA_PHONE_EXAMPLE,
  OTP_RESEND_COOLDOWN_SECONDS,
  formatCountdown,
  formatGhanaPhone,
  normalizeGhanaPhone,
} from "@rida/shared";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { ApiError, login, requestOtp, signInWithPasskey, verifyOtp } from "../api";
import { useAuth } from "../auth";

/** What the browser's own refusal means, in words ("NotAllowedError" is a cancel or a timeout). */
function passkeyProblem(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const name = (err as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "AbortError") return "Passkey sign-in was cancelled. Try again, or use a phone code.";
  return "Your browser couldn't use a passkey here. Use a phone code instead.";
}

/**
 * Passkey first (Face ID / Touch ID; api.signInWithPasskey): no number to
 * type, nothing to phish. A phone code stays as the fallback — for admins
 * with no passkey yet, or for everyone while the server allows it
 * (ADMIN_OTP_FALLBACK); otherwise the server says to use the passkey.
 *
 * Phone + OTP login, reusing the existing /auth/request-otp → /auth/verify-otp
 * → /auth/login chain exactly as the rider and driver apps do. There is no
 * separate admin credential anywhere.
 *
 * The site marks its requests (X-CampusRide-Client: admin, in api.ts), so
 * the server issues a session only to an ADMIN account whose number is on
 * ADMIN_PHONE_ALLOWLIST, refuses everyone else with an honest message, and
 * records every attempt for "Recent admin logins". The role check below is a
 * second line, not the gate.
 */
export function LoginScreen() {
  const { signIn, endedReason } = useAuth();
  const passkeysWork = browserSupportsWebAuthn();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [showPhone, setShowPhone] = useState(!passkeysWork);
  const [phone, setPhone] = useState("");
  // The number as the server knows it (+233XXXXXXXXX), from the shared parser:
  // used for every step after "Send code", whatever was typed or pasted.
  const [canonicalPhone, setCanonicalPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // "Resend code" counts down rather than letting the button be hammered: the
  // server sends a number one code per cooldown (and fewer to an admin's).
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  useEffect(() => {
    if (resendIn === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  async function signInByPasskey() {
    setError(null);
    setBusy(true);
    try {
      const result = await signInWithPasskey();
      signIn({
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        sessionExpiresAt: result.sessionExpiresAt,
        signedInWith: "passkey",
      });
    } catch (err) {
      setError(passkeyProblem(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendCode() {
    setError(null);
    setBusy(true);
    try {
      const canonical = normalizeGhanaPhone(phone);
      if (!canonical) {
        setError(GHANA_PHONE_EXAMPLE);
        return;
      }
      setCanonicalPhone(canonical);
      await requestOtp(canonical);
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setStep("code");
    } catch (err) {
      if (err instanceof ApiError && err.retryAfterSeconds) setResendAt(Date.now() + err.retryAfterSeconds * 1000);
      setError(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      setNow(Date.now());
      setBusy(false);
    }
  }

  async function handleSendCode(event: React.FormEvent) {
    event.preventDefault();
    await sendCode();
  }

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { verifiedToken } = await verifyOtp(canonicalPhone, code.trim());
      const result = await login(canonicalPhone, verifiedToken);

      if (result.user.role !== "ADMIN") {
        setError("This account is not an administrator.");
        setStep("phone");
        setCode("");
        return;
      }

      signIn({
        user: result.user,
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        sessionExpiresAt: result.sessionExpiresAt,
        signedInWith: "code",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="card login-card">
        <h1>CampusRide Admin</h1>
        {passkeysWork ? (
          <>
            <p className="muted">Sign in with your passkey (Face ID or Touch ID).</p>
            <button type="button" disabled={busy} onClick={() => void signInByPasskey()}>
              {busy && !showPhone ? "Waiting for your passkey…" : "Sign in with a passkey"}
            </button>
            {!showPhone ? (
              <button type="button" className="link" disabled={busy} onClick={() => setShowPhone(true)}>
                Use a phone code instead
              </button>
            ) : null}
          </>
        ) : null}

        {showPhone ? (
          <p className="muted">
            {passkeysWork ? "Or sign in" : "Sign in"} with the phone number of an administrator account.
          </p>
        ) : null}

        {!showPhone ? null : step === "phone" ? (
          <form onSubmit={handleSendCode}>
            <label htmlFor="phone">Phone number</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="0XXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <button type="submit" disabled={busy || phone.trim().length === 0}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={handleVerify}>
            <label htmlFor="code">6-digit code sent to {formatGhanaPhone(canonicalPhone)}</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <button type="submit" disabled={busy || code.trim().length === 0}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button type="button" className="link" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>
              {resendIn > 0 ? `Resend code in ${formatCountdown(resendIn)}` : "Resend code"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setStep("phone");
                setCode("");
                setError(null);
              }}
            >
              Use a different number
            </button>
          </form>
        )}

        {error ? <p className="error">{error}</p> : null}
        {!error && endedReason ? <p className="muted">{endedReason}</p> : null}
      </div>
    </div>
  );
}
