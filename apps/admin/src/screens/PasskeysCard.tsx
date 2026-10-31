import { useEffect, useState } from "react";
import { browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { ApiError, addPasskey, failureText, getPasskeys, removePasskey, type Passkey } from "../api";
import { useAuth, useToken } from "../auth";
import { dayAndTime, shortDay } from "../lib/time";

/** A starting name for a passkey made on this device. */
function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android phone";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

/**
 * Settings → Passkeys: the signed-in admin's own passkeys (Face ID / Touch
 * ID). Once there is one, signing in with a phone code is off for this
 * account unless the server allows it (ADMIN_OTP_FALLBACK), so keep a
 * passkey on two devices (with iCloud Keychain they sync by themselves).
 */
export function PasskeysCard() {
  const token = useToken();
  const { signOut } = useAuth();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [name, setName] = useState(deviceName);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = browserSupportsWebAuthn();

  async function run(section: string, action: () => Promise<void>) {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      const browserName = (err as { name?: string } | null)?.name;
      setError(
        err instanceof ApiError
          ? failureText(section, err)
          : browserName === "InvalidStateError"
            ? "This device already has a passkey for your account."
            : browserName === "NotAllowedError" || browserName === "AbortError"
              ? "Cancelled."
              : "The passkey couldn't be added.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    setPasskeys((await getPasskeys(token)).passkeys);
  }

  useEffect(() => {
    void run("Loading passkeys", load);
    // Once, on opening the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function add(event: React.FormEvent) {
    event.preventDefault();
    void run("Adding a passkey", async () => {
      await addPasskey(token, name.trim() || deviceName());
      await load();
      setNotice("Passkey added. Next time, sign in with it.");
    });
  }

  function remove(passkey: Passkey) {
    const last = passkeys?.length === 1;
    const sentence = last
      ? `Remove "${passkey.name}"? It is your only passkey: you'll sign in with a phone code again.`
      : `Remove "${passkey.name}"? It won't sign you in any more.`;
    if (!window.confirm(sentence)) return;
    void run("Removing a passkey", async () => {
      await removePasskey(token, passkey.id);
      await load();
    });
  }

  return (
    <div className="inset">
      <h3>Passkeys</h3>
      <p className="muted small">
        Sign in with Face ID or Touch ID instead of a texted code. Once you have a passkey, phone
        codes stop working for your account (a stolen SIM can&apos;t get in), so add one on a second
        device too, or use iCloud Keychain, which shares it with your other Apple devices.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      {passkeys === null ? (
        <p className="muted">Loading…</p>
      ) : passkeys.length === 0 ? (
        <p className="muted">No passkeys yet.</p>
      ) : (
        <ul className="passkey-list">
          {passkeys.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.name}</strong>
                <span className="muted small">
                  {" "}
                  · added {shortDay(p.createdAt)}
                  {p.lastUsedAt ? ` · last used ${dayAndTime(p.lastUsedAt)}` : " · not used yet"}
                  {p.backedUp ? " · synced" : ""}
                </span>
              </span>
              <button type="button" className="text-button" disabled={busy} onClick={() => remove(p)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <form className="filters" onSubmit={add}>
          <div>
            <label htmlFor="passkey-name">Name for this device&apos;s passkey</label>
            <input id="passkey-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <button type="submit" className="tonal-button" disabled={busy}>
            {busy ? "Waiting…" : "Add a passkey on this device"}
          </button>
        </form>
      ) : (
        <p className="muted small">This browser can&apos;t make passkeys.</p>
      )}
    </div>
  );
}
