import { useEffect, useState } from "react";
import { GHANA_PHONE_EXAMPLE, normalizeGhanaPhone } from "@rida/shared";
import {
  ApiError,
  deleteAccountByEmail,
  lookUpForDeletion,
  sendDeletionCode,
  verifyDeletionCode,
  type DeletionLookup,
} from "../api";
import { useAuth, useToken } from "../auth";
import { shortDay } from "../lib/time";

/**
 * For someone who asked by email to delete their account (the no-app route
 * on campusride.app/delete-account). Look up the number from the email, text
 * it a code, type in the code they email back, then delete. Only a right
 * code unlocks the delete button; the server checks it again either way.
 * Deleting does exactly what the app's own Delete account does. Every step
 * is written to the audit log.
 */
export function DeleteAccountScreen({ phone: initialPhone }: { phone?: string } = {}) {
  const token = useToken();
  const { signOut } = useAuth();
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [result, setResult] = useState<DeletionLookup | null>(null);
  const [codeSent, setCodeSent] = useState<{ phone: string; minutes: number } | null>(null);
  const [code, setCode] = useState("");
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setResult(null);
    setCodeSent(null);
    setCode("");
    setConfirmToken(null);
    setDone(null);
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        signOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : "The request failed");
    } finally {
      setBusy(false);
    }
  }

  // Opened for a known number (a rider's detail): look it up straight away.
  useEffect(() => {
    if (initialPhone) void run(async () => setResult(await lookUpForDeletion(token, initialPhone)));
    // Once per number.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPhone]);

  function lookUp(event: React.FormEvent) {
    event.preventDefault();
    const canonical = normalizeGhanaPhone(phone);
    if (!canonical) {
      setError(GHANA_PHONE_EXAMPLE);
      return;
    }
    reset();
    void run(async () => setResult(await lookUpForDeletion(token, canonical)));
  }

  function sendCode() {
    if (!result) return;
    void run(async () => {
      const sent = await sendDeletionCode(token, result.phone);
      setCodeSent({ phone: sent.phone, minutes: sent.expiresInMinutes });
      setCode("");
      setConfirmToken(null);
    });
  }

  function checkCode(event: React.FormEvent) {
    event.preventDefault();
    if (!result) return;
    void run(async () => {
      const checked = await verifyDeletionCode(token, result.phone, code.trim());
      setConfirmToken(checked.confirmToken);
    });
  }

  function remove() {
    if (!result?.account || !confirmToken) return;
    const { name, role } = result.account;
    if (!window.confirm(`Delete ${name}'s ${role.toLowerCase()} account (${result.phone})? This can't be undone.`)) return;
    void run(async () => {
      const deleted = await deleteAccountByEmail(token, result.phone, confirmToken);
      setDone(
        `Deleted. Their kept details are erased on ${shortDay(deleted.erasedAfter)}. ` +
          "Email them to say it's done.",
      );
      setConfirmToken(null);
      setCodeSent(null);
    });
  }

  const account = result?.account ?? null;
  const deletable = account !== null && result?.blocked === null && done === null;

  return (
    <div>
      <p className="muted">
        For someone who emailed asking to delete their account. We text a code to the number on the
        account; they email it back, and only that code unlocks deleting. Deleting does exactly what
        the app&apos;s own Delete account does.
      </p>

      {initialPhone ? null : (
      <form className="filters" onSubmit={lookUp}>
        <div className="field">
          <label htmlFor="delete-phone">Phone number from the email</label>
          <input
            id="delete-phone"
            type="tel"
            placeholder="0XXXXXXXXX"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              reset();
            }}
            required
          />
        </div>
        <button type="submit" className="tonal-button" disabled={busy || phone.trim().length === 0}>
          {busy && !result ? "Looking…" : "Look up"}
        </button>
      </form>
      )}

      {error ? <p className="error-text" role="alert">{error}</p> : null}

      {result ? (
        <div className="inset">
          {account ? (
            <p>
              <strong>{done ? "Deleted user" : account.name}</strong>{" "}
              <span className="muted">
                {account.role.toLowerCase()} · {result.phone} · joined{" "}
                {shortDay(account.createdAt)}
              </span>
            </p>
          ) : (
            <p>
              <strong>No account found</strong> <span className="muted">for {result.phone}.</span>
            </p>
          )}

          {result.blocked ? <p className="error-text">{result.blocked.message}</p> : null}
          {done ? <p>{done}</p> : null}

          {deletable ? (
            <>
              <p>
                <button type="button" className="tonal-button" disabled={busy} onClick={sendCode}>
                  {codeSent ? "Send a new code" : "Send verification code"}
                </button>
              </p>
              {codeSent ? (
                <p className="muted">
                  Code texted to {codeSent.phone}. It works for {codeSent.minutes} minutes. Ask them to
                  reply to the email with it.
                </p>
              ) : null}

              {codeSent && !confirmToken ? (
                <form className="filters" onSubmit={checkCode}>
                  <div className="field">
                    <label htmlFor="delete-code">Code they emailed back</label>
                    <input
                      id="delete-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      required
                    />
                  </div>
                  <button type="submit" className="tonal-button" disabled={busy || code.trim().length === 0}>
                    Check code
                  </button>
                </form>
              ) : null}

              {confirmToken ? (
                <>
                  <p className="muted">Code correct. Delete within 5 minutes, or send a new code.</p>
                  <p>
                    <button type="button" className="danger-button" disabled={busy} onClick={remove}>
                      Delete account
                    </button>
                  </p>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
