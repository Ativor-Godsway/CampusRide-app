import { useState } from "react";
import { ApiError, login, requestOtp, verifyOtp } from "../api";
import { useAuth } from "../auth";

/**
 * Phone + OTP login, reusing the existing /auth/request-otp → /auth/verify-otp
 * → /auth/login chain exactly as the rider and driver apps do. There is no
 * separate admin credential anywhere.
 *
 * The ADMIN gate is applied AFTER a successful login: a rider or driver can
 * authenticate here (their phone is a real account) but gets no session. The
 * real enforcement is server-side in requireAdmin — this check exists so a
 * non-admin sees an honest message instead of a screen of 403s.
 */
export function LoginScreen() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSendCode(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestOtp(phone.trim());
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { verifiedToken } = await verifyOtp(phone.trim(), code.trim());
      const result = await login(phone.trim(), verifiedToken);

      if (result.user.role !== "ADMIN") {
        setError("This account is not an administrator.");
        setStep("phone");
        setCode("");
        return;
      }

      signIn({ user: result.user, accessToken: result.accessToken });
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
        <p className="muted">Sign in with the phone number of an administrator account.</p>

        {step === "phone" ? (
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
            <label htmlFor="code">6-digit code sent to {phone}</label>
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
      </div>
    </div>
  );
}
