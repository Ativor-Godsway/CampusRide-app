import { useEffect, useState } from "react";
import { MOVING_STEPS, MOVING_STEP_LABELS } from "@rida/shared";
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
  const [movingFirst, setMovingFirst] = useState(true);
  const [autoAddDefault, setAutoAddDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (d: DispatchSettings) => {
    setLoaded(d);
    setValue(String(d.settings.searchWindowSeconds / 60));
    setMovingFirst(d.settings.movingFirstEnabled ?? true);
    setAutoAddDefault(d.settings.autoAddDefault ?? false);
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
      show(await saveDispatchSettings(token, parsed, { movingFirstEnabled: movingFirst, autoAddDefault }));
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
          <label className="settings-option">
            <input type="checkbox" checked={movingFirst} onChange={(e) => setMovingFirst(e.target.checked)} />
            <span>
              <strong>Fill moving cars first</strong>
              <br />
              <span className="muted small">
                A new Shared request goes first to the best car already on a trip going the same way (within the scheduled-ride detour limits). Only if
                that driver doesn&rsquo;t take it does it go to everyone else.
              </span>
            </span>
          </label>
          <label className="settings-option">
            <input type="checkbox" checked={autoAddDefault} onChange={(e) => setAutoAddDefault(e.target.checked)} disabled={!movingFirst} />
            <span>
              <strong>Auto-add riders, by default</strong>
              <br />
              <span className="muted small">
                For drivers who haven&rsquo;t chosen: the rider joins at once and the driver can undo for 15 seconds. Off: the driver gets the offer for 20
                seconds. Each driver can change it in their app.
              </span>
            </span>
          </label>
          {loaded.movingSteps7d ? (
            <p className="muted small" data-testid="moving-steps">
              Last 7 days:{" "}
              {MOVING_STEPS.filter((k) => loaded.movingSteps7d![k]).map((k) => `${MOVING_STEP_LABELS[k]} ${loaded.movingSteps7d![k]}`).join(" · ") || "no Shared requests yet"}
            </p>
          ) : null}
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
            <button type="submit" className="tonal-button" disabled={
                busy ||
                !valid ||
                (parsed === loaded.settings.searchWindowSeconds &&
                  movingFirst === (loaded.settings.movingFirstEnabled ?? true) &&
                  autoAddDefault === (loaded.settings.autoAddDefault ?? false))
              }>
              {busy ? "Saving…" : "Save"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
