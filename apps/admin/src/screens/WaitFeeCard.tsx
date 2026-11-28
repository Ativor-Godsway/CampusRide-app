import { useEffect, useState } from "react";
import { waitFeeSettingsProblem } from "@rida/shared";
import { ApiError, failureText, getWaitFeeSettings, saveWaitFeeSettings, type WaitFeeSettingsBody } from "../api";
import { useToken } from "../auth";
import { cedis, cedisInput, parseCedis } from "../lib/money";
import { dayAndTime } from "../lib/time";

/** "2:30" for 150 seconds. */
function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** "2:30" or "150" as seconds; null if it isn't either. */
function parseClock(input: string): number | null {
  const t = input.trim();
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return /^\d{1,4}$/.test(t) ? Number(t) : null;
}

/**
 * The pickup wait fee (server: services/ride/waitFee.ts): the free wait after
 * the driver arrives, the flat fee added to a late rider's fare after it, and
 * when "Rider didn't show" opens. A change applies to waits that start after
 * it; a wait already running keeps its own. Audit-logged.
 */
export function WaitFeeCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<WaitFeeSettingsBody | null>(null);
  const [free, setFree] = useState("");
  const [fee, setFee] = useState("");
  const [noShow, setNoShow] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (d: WaitFeeSettingsBody) => {
    setLoaded(d);
    setFree(clock(d.settings.freeWaitSeconds));
    setFee(cedisInput(d.settings.feePesewas));
    setNoShow(String(d.settings.noShowMinutes));
  };
  useEffect(() => {
    getWaitFeeSettings(token).then(show, (err) => setError(failureText("Loading the wait fee settings", err)));
  }, [token]);

  const values = {
    freeWaitSeconds: parseClock(free) ?? NaN,
    feePesewas: parseCedis(fee) ?? NaN,
    noShowMinutes: /^\d{1,3}$/.test(noShow.trim()) ? Number(noShow) : NaN,
  };
  const problem = waitFeeSettingsProblem(values);
  const unchanged =
    loaded !== null &&
    values.freeWaitSeconds === loaded.settings.freeWaitSeconds &&
    values.feePesewas === loaded.settings.feePesewas &&
    values.noShowMinutes === loaded.settings.noShowMinutes;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveWaitFeeSettings(token, values));
      setNotice("Saved. It applies to waits that start from now; a wait already running keeps its own.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the wait fee settings", err) : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="section-help">
        When the driver taps Arrived within about 100 m of the pickup, the rider gets a free wait. If they aren&rsquo;t picked up by the end of it, a flat
        fee is added to their fare (theirs only), and only if they were told: the arrival notification reached their phone or their app shows the timer.
        &ldquo;Rider didn&rsquo;t show&rdquo; opens after the no-show wait; a no-show pays nothing.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="saved-note">✓ {notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="stack" onSubmit={(e) => void save(e)}>
          <div className="filters">
            <label className="field">
              <span>Free wait (m:ss)</span>
              <input inputMode="numeric" value={free} onChange={(e) => setFree(e.target.value)} required />
            </label>
            <label className="field">
              <span>Wait fee (GHS, 0 = none)</span>
              <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} required />
            </label>
            <label className="field">
              <span>No-show after (minutes)</span>
              <input inputMode="numeric" value={noShow} onChange={(e) => setNoShow(e.target.value)} required />
            </label>
          </div>
          {problem ? <p className="error-text">{problem}</p> : null}
          {!problem ? (
            <p className="example">
              Example: the driver arrives at 10:00 and the rider gets in at 10:{String(Math.floor((loaded.settings.freeWaitSeconds + 60) / 60)).padStart(2, "0")} → their fare goes up by {cedis(loaded.settings.feePesewas)}.
            </p>
          ) : null}
          <div className="row-between">
            <span className="section-meta">
              {loaded.settings.updatedAt
                ? `Last changed by ${loaded.settings.updatedBy?.name ?? "an admin"} · ${dayAndTime(loaded.settings.updatedAt)}`
                : `Not changed yet: the defaults, ${clock(loaded.defaults.freeWaitSeconds)} free, ${cedis(loaded.defaults.feePesewas)}, no-show after ${loaded.defaults.noShowMinutes} min.`}
            </span>
            <button type="submit" className="primary-button" disabled={busy || !!problem || unchanged}>
              {busy ? "Saving…" : "Save wait fee"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
