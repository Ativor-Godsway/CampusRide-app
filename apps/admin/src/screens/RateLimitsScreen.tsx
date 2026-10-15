import { useState } from "react";
import { retryAfterText } from "@rida/shared";
import { ApiError, clearRateLimits, getRateLimits, type RateLimitLookup } from "../api";
import { useAuth, useToken } from "../auth";

/**
 * For "I can't log in" calls: what a phone number's rate limits look like
 * right now, and a button to clear them. Limits are per number and per
 * account, so clearing one person never affects anyone else. Looking and
 * clearing are both written to the audit log.
 */
export function RateLimitsScreen() {
  const token = useToken();
  const { signOut } = useAuth();
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<RateLimitLookup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
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
      setError(err instanceof ApiError ? err.message : "The request failed");
    } finally {
      setBusy(false);
    }
  }

  function lookUp(event: React.FormEvent) {
    event.preventDefault();
    void run(async () => setResult(await getRateLimits(token, phone.trim())));
  }

  function clear() {
    if (!result) return;
    if (!window.confirm(`Clear every rate limit for ${result.phone}?`)) return;
    void run(async () => {
      const { cleared } = await clearRateLimits(token, result.phone);
      setNotice(
        cleared.length
          ? `Cleared ${cleared.length} limit(s) for ${result.phone}.`
          : "Nothing was in use.",
      );
      setResult(await getRateLimits(token, result.phone));
    });
  }

  const blocked = result?.limits.filter((l) => l.blocked).length ?? 0;

  return (
    <section>
      <div className="section-head">
        <h2>Rate limits</h2>
      </div>
      <p className="muted">
        Look up a phone number someone can&apos;t log in or book with. Limits count per number and
        per account, so clearing one person never touches anyone else.
      </p>

      <form className="filters" onSubmit={lookUp}>
        <div>
          <label htmlFor="limit-phone">Phone number</label>
          <input
            id="limit-phone"
            type="tel"
            placeholder="0XXXXXXXXX"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={busy || phone.trim().length === 0}>
          {busy ? "Looking…" : "Look up"}
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      {result ? (
        <>
          <p>
            <strong>{result.phone}</strong>{" "}
            <span className="muted">
              {result.account
                ? `${result.account.name} (${result.account.role.toLowerCase()})`
                : "no account"}
              {" · "}
              {blocked > 0 ? `${blocked} blocked` : "nothing blocked"}
            </span>
          </p>

          {result.limits.length === 0 ? (
            <p className="muted">No limits are in use for this number.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Limit</th>
                    <th>Counts</th>
                    <th>Used</th>
                    <th>Resets in</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {result.limits.map((limit) => (
                    <tr key={`${limit.scope}:${limit.name}`}>
                      <td>{limit.label}</td>
                      <td>{limit.scope === "phone" ? "This number" : "Their account"}</td>
                      <td>
                        {limit.used} / {limit.max}
                      </td>
                      <td>{retryAfterText(limit.resetsInSeconds)}</td>
                      <td>
                        {limit.blocked ? (
                          <span className="badge badge-cancelled">Blocked</span>
                        ) : (
                          <span className="badge">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p>
            <button type="button" className="danger" disabled={busy} onClick={clear}>
              Clear this number&apos;s limits
            </button>
          </p>
        </>
      ) : null}
    </section>
  );
}
