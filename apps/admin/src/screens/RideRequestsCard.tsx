import { useEffect, useState } from "react";
import { ApiError, failureText, getDispatchSettings, saveDispatchSettings, type DispatchSettings } from "../api";
import { useToken } from "../auth";
import { dayAndTime } from "../lib/time";

/** "7 min", "1 min 30 s". */
function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * How long a ride request searches for a driver before the rider is told no
 * driver was found (server: services/ride/searchWindow.ts). The offer pop-up
 * is separate (DRIVER_OFFER_SECONDS on Render); the request stays on the
 * drivers' request board for the whole window. Audit-logged.
 */
export function RideRequestsCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<DispatchSettings | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (d: DispatchSettings) => {
    setLoaded(d);
    setValue(String(d.settings.searchWindowSeconds / 60));
  };
  useEffect(() => {
    getDispatchSettings(token).then(show, (err) => setError(failureText("Loading the ride request settings", err)));
  }, [token]);

  const parsed = /^\d+(\.5)?$/.test(value.trim()) ? Math.round(Number(value) * 60) : null;
  const valid = parsed !== null && loaded !== null && parsed >= loaded.bounds.min && parsed <= loaded.bounds.max;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || parsed === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveDispatchSettings(token, parsed));
      setNotice("Saved. It applies at once, to requests already searching too.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the ride request settings", err) : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Ride requests</h3>
      <p className="muted">
        How long a request looks for a driver before the rider sees &ldquo;no driver found&rdquo;. Drivers get the pop-up for its usual seconds, and the request
        stays on their Requests board for the whole time.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <div className="filters">
            <label className="field">
              <span>Search for (minutes)</span>
              <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required />
            </label>
          </div>
          {!valid ? (
            <p className="error-text">
              From {minutes(loaded.bounds.min)} to {minutes(loaded.bounds.max)}, in whole or half minutes.
            </p>
          ) : null}
          <p className="muted small">
            {loaded.settings.updatedAt
              ? `Last changed ${dayAndTime(loaded.settings.updatedAt)}${loaded.settings.updatedBy ? ` by ${loaded.settings.updatedBy.name}` : ""}.`
              : `Not changed yet: the default, ${minutes(loaded.defaults.searchWindowSeconds)}.`}
          </p>
          <p>
            <button type="submit" className="tonal-button" disabled={busy || !valid || parsed === loaded.settings.searchWindowSeconds}>
              {busy ? "Saving…" : "Save"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
