import { useEffect, useState } from "react";
import { feePercentText, paystackQuote, parseFeePercent, warningLevelPesewas } from "@rida/shared";
import { ApiError, failureText, getCommissionSettings, saveCommissionSettings, type CommissionSettings } from "../api";
import { useToken } from "../auth";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

/**
 * The commission rules (stored on the server, audit-logged): how much a
 * driver may owe before they can't go online, when the app warns them,
 * whether that is enforced at all (off during the commission-free launch:
 * commission still piles up, nobody is blocked), and Paystack's fee, which
 * drivers add on top when they pay so CampusRide receives the whole balance.
 */
export function CommissionRulesCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<CommissionSettings | null>(null);
  const [limit, setLimit] = useState("");
  const [warning, setWarning] = useState("");
  const [enforced, setEnforced] = useState(false);
  const [fee, setFee] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (s: CommissionSettings) => {
    setLoaded(s);
    setLimit(cedisInput(s.settings.debtLimitPesewas));
    setWarning(String(s.settings.warningPercent));
    setEnforced(s.settings.enforcementEnabled);
    setFee(feePercentText(s.settings.feeBps).replace("%", ""));
    setCap(s.settings.feeCapPesewas === null ? "" : cedisInput(s.settings.feeCapPesewas));
  };

  useEffect(() => {
    getCommissionSettings(token).then(show, (err) => setError(failureText("Loading the commission rules", err)));
  }, [token]);

  const limitPesewas = parseCedis(limit);
  const warningPercent = /^\d{1,3}$/.test(warning.trim()) ? Number(warning) : null;
  const feeBps = parseFeePercent(fee);
  const capPesewas = cap.trim() === "" ? null : parseCedis(cap);
  const valid = limitPesewas !== null && limitPesewas >= 100 && warningPercent !== null && warningPercent >= 1 && warningPercent <= 100 && feeBps !== null && (cap.trim() === "" || (capPesewas !== null && capPesewas > 0));
  const example = valid ? paystackQuote(warningLevelPesewas({ debtLimitPesewas: limitPesewas, warningPercent }), feeBps, capPesewas) : null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || !loaded) return;
    if (enforced && !loaded.settings.enforcementEnabled) {
      if (!window.confirm(`Turn enforcement on? Drivers who owe ${cedis(limitPesewas)} or more won't be able to go online until they pay. Nobody is taken offline or stopped mid-trip.`)) return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveCommissionSettings(token, { debtLimitPesewas: limitPesewas, warningPercent, enforcementEnabled: enforced, feeBps, feeCapPesewas: capPesewas }));
      setNotice("Saved. Driver apps pick it up the next time they open Balance or go online.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the commission rules", err) : "Saving the commission rules failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Driver commission</h3>
      <p className="muted">
        Drivers keep 85% of each cash fare and owe CampusRide 15%. They pay it from the driver app through Paystack (MoMo), or to you in person (Finances).
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {loaded && !loaded.paystackConfigured ? (
        <p className="warn-text">PAYSTACK_SECRET_KEY isn&apos;t set on the server, so drivers can&apos;t pay in the app yet.</p>
      ) : loaded?.paystackTestMode ? (
        <p className="warn-text">The server has a Paystack test key: payments are test payments, no real money moves.</p>
      ) : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <label className="settings-option">
            <input type="checkbox" checked={enforced} onChange={(e) => setEnforced(e.target.checked)} />
            <span>
              <strong>Enforce the limit</strong>
              <span className="muted small">
                {" "}
                Off (the commission-free launch): commission is still worked out and adds up, but no driver is ever blocked or warned. On: a driver who owes the
                limit or more can&apos;t go online until they pay. A trip under way is never interrupted.
              </span>
            </span>
          </label>
          <div className="filters">
            <label className="field">
              <span>Debt limit (GH₵)</span>
              <input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} required />
            </label>
            <label className="field">
              <span>Warn drivers at (% of the limit)</span>
              <input inputMode="numeric" value={warning} onChange={(e) => setWarning(e.target.value)} required />
            </label>
          </div>
          {valid ? (
            <p className="muted small">
              Drivers see &ldquo;Pay before {cedis(limitPesewas)} to keep driving&rdquo; from {cedis(warningLevelPesewas({ debtLimitPesewas: limitPesewas, warningPercent }))}
              {enforced ? "." : " once the limit is enforced."}
            </p>
          ) : null}
          <div className="filters">
            <label className="field">
              <span>Paystack fee (%)</span>
              <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} required />
            </label>
            <label className="field">
              <span>Fee cap (GH₵, optional)</span>
              <input inputMode="decimal" value={cap} placeholder="No cap" onChange={(e) => setCap(e.target.value)} />
            </label>
          </div>
          <p className="muted small">
            Check your current rate in the Paystack dashboard. Drivers add the fee on top so CampusRide receives their whole balance
            {example ? `: someone owing ${cedis(example.owedPesewas)} pays ${cedis(example.grossPesewas)} (${cedis(example.feePesewas)} fee)` : ""}.
            {loaded.envDefaults.feeBps || loaded.envDefaults.feeCapPesewas
              ? ` Default from the server: ${feePercentText(loaded.envDefaults.feeBps)}${loaded.envDefaults.feeCapPesewas ? `, capped at ${cedis(loaded.envDefaults.feeCapPesewas)}` : ""}.`
              : ""}
          </p>
          {!valid ? <p className="error-text">Check the numbers: a limit of at least GH₵1, a warning from 1 to 100%, a fee like 1.95, and a cap in cedis or empty.</p> : null}
          {loaded.settings.updatedAt ? (
            <p className="muted small">
              Last changed {dayAndTime(loaded.settings.updatedAt)}
              {loaded.settings.updatedBy ? ` by ${loaded.settings.updatedBy.name}` : ""}.
            </p>
          ) : (
            <p className="muted small">Not changed yet: these are the defaults.</p>
          )}
          <p>
            <button type="submit" className="tonal-button" disabled={busy || !valid}>
              {busy ? "Saving…" : "Save commission rules"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
