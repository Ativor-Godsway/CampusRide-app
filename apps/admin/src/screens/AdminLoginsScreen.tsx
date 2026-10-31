import { useCallback, useEffect, useState } from "react";
import { ApiError, failureText, getRecentLogins, type AdminLoginEvent } from "../api";
import { useAuth, useToken } from "../auth";
import { dayAndTime } from "../lib/time";

/** What each failure reason means, in plain words. */
const REASONS: Record<string, string> = {
  bad_code: "wrong code",
  code_expired: "code expired",
  too_many_attempts: "too many wrong codes",
  rate_limited: "too many attempts",
  no_account: "no account for this number",
  not_admin: "not an admin account",
  not_allowlisted: "admin account not on the allowlist",
  invalid_verification: "verification expired",
  passkey_required: "phone code for an admin who has a passkey",
  passkey_failed: "passkey didn't verify, or isn't registered",
};

/** "Chrome on macOS" from a user-agent string — good enough to spot a stranger's device. */
function deviceOf(userAgent: string | null): string {
  if (!userAgent) return "—";
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Chrome\//.test(userAgent)
      ? "Chrome"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : /okhttp|Expo|CampusRide/i.test(userAgent)
            ? "a phone app"
            : "a browser";
  const os = /Android/.test(userAgent)
    ? "Android"
    : /iPhone|iPad/.test(userAgent)
      ? "iOS"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Every attempt to sign in to the admin site, newest first: successes,
 * failures and codes sent to admin numbers, with where they came from. A
 * sign-in you don't recognise — a new place or device, especially right
 * after your phone lost signal — can mean someone has your SIM: remove the
 * number from ADMIN_PHONE_ALLOWLIST on Render straight away.
 */
export function AdminLoginsScreen() {
  const token = useToken();
  const { signOut } = useAuth();
  const [logins, setLogins] = useState<AdminLoginEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLogins((await getRecentLogins(token)).logins);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        signOut();
        return;
      }
      setError(failureText("Loading admin sign-ins", err));
    } finally {
      setLoading(false);
    }
  }, [token, signOut]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="queue-head">
        <span />
        <button type="button" className="text-button" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Every attempt to sign in to this site. If you see a sign-in you don&apos;t recognise,
        someone may have your number: take it off ADMIN_PHONE_ALLOWLIST on Render straight away.
      </p>

      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : logins.length === 0 ? (
        <p className="muted">No sign-in attempts recorded yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="mini-table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Who</th>
                <th>From (IP)</th>
                <th>Device</th>
              </tr>
            </thead>
            <tbody>
              {logins.map((login) => (
                <tr key={login.id}>
                  <td>{dayAndTime(login.at)}</td>
                  <td>
                    {login.outcome === "success" ? (
                      <span className="chip chip-green">
                        Signed in{login.reason === "passkey" ? " with a passkey" : ""}
                      </span>
                    ) : login.outcome === "failure" ? (
                      <span className="chip chip-red">
                        Refused{login.reason ? `: ${REASONS[login.reason] ?? login.reason}` : ""}
                      </span>
                    ) : (
                      <span className="chip chip-neutral">Code sent</span>
                    )}
                  </td>
                  <td>{login.account ? login.account.name : (login.target ?? "unknown")}</td>
                  <td>{login.ip ?? "—"}</td>
                  <td title={login.userAgent ?? undefined}>{deviceOf(login.userAgent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
