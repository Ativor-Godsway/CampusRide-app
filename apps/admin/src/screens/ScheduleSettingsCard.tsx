import { useEffect, useState } from "react";
import { SCHEDULE_SETTING_FIELDS, scheduleSettingsProblem, type ScheduleSettings } from "@rida/shared";
import { ApiError, failureText, getScheduleSettings, saveScheduleSettings, type ScheduleSettingsBody } from "../api";
import { useToken } from "../auth";
import { dayAndTime } from "../lib/time";

const UNIT_WORDS = { min: "min", seats: "seats", m: "metres", strikes: "strikes", days: "days" } as const;

/** The form's values (text while typing) as settings; a field that isn't a whole number is NaN. */
export function scheduleValues(enabled: boolean, introEnabled: boolean, inputs: Record<string, string>): ScheduleSettings {
  const out: Record<string, number | boolean> = { enabled, introEnabled };
  for (const f of SCHEDULE_SETTING_FIELDS) {
    const t = (inputs[f.key] ?? "").trim();
    out[f.key] = /^\d{1,5}$/.test(t) ? Number(t) : NaN;
  }
  return out as unknown as ScheduleSettings;
}

/**
 * Scheduled rides (server: services/scheduled): on/off, the rider intro, and
 * every number the rules use — slots, cutoff, grouping radius, when cars are
 * offered or become live requests, reminders, the driver gap, free cancel and
 * strikes. Cars already booked follow new numbers from the next minute.
 * Audit-logged.
 */
export function ScheduleSettingsCard() {
  const token = useToken();
  const [loaded, setLoaded] = useState<ScheduleSettingsBody | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [intro, setIntro] = useState(true);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const show = (d: ScheduleSettingsBody) => {
    setLoaded(d);
    setEnabled(d.settings.enabled);
    setIntro(d.settings.introEnabled);
    setInputs(Object.fromEntries(SCHEDULE_SETTING_FIELDS.map((f) => [f.key, String(d.settings[f.key])])));
  };
  useEffect(() => {
    getScheduleSettings(token).then(show, (err) => setError(failureText("Loading the scheduled ride settings", err)));
  }, [token]);

  const values = scheduleValues(enabled, intro, inputs);
  const problem = scheduleSettingsProblem(values);
  const unchanged =
    loaded !== null &&
    values.enabled === loaded.settings.enabled &&
    values.introEnabled === loaded.settings.introEnabled &&
    SCHEDULE_SETTING_FIELDS.every((f) => values[f.key] === loaded.settings[f.key]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      show(await saveScheduleSettings(token, values));
      setNotice("Saved. Scheduled cars follow the new numbers within a minute.");
    } catch (err) {
      setError(err instanceof ApiError ? failureText("Saving the scheduled ride settings", err) : "Saving failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset">
      <h3>Scheduled rides</h3>
      <p className="muted">
        Riders book Shared seats for an arrive-by time. Bookings going the same way share a car; cars are offered to drivers by how full they are, and a
        car no driver takes in time becomes live requests. Late cancels and no-shows are strikes.
      </p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : (
        <form className="settings-form" onSubmit={(e) => void save(e)}>
          <label className="settings-option">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Riders can schedule rides
          </label>
          <label className="settings-option">
            <input type="checkbox" checked={intro} onChange={(e) => setIntro(e.target.checked)} /> Show the &ldquo;Book your ride ahead&rdquo; intro in the rider app
          </label>
          <div className="filters">
            {SCHEDULE_SETTING_FIELDS.map((f) => (
              <label className="field" key={f.key}>
                <span>
                  {f.label} ({UNIT_WORDS[f.unit]})
                </span>
                <input
                  inputMode="numeric"
                  value={inputs[f.key] ?? ""}
                  onChange={(e) => setInputs((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  aria-describedby={`sched-${f.key}-range`}
                  required
                />
                <span id={`sched-${f.key}-range`} className="muted small">
                  {f.min}–{f.max}, default {loaded.defaults[f.key]}
                </span>
              </label>
            ))}
          </div>
          {problem ? <p className="error-text">{problem}</p> : null}
          <p className="muted small">
            {loaded.settings.updatedAt
              ? `Last changed ${dayAndTime(loaded.settings.updatedAt)}${loaded.settings.updatedBy ? ` by ${loaded.settings.updatedBy.name}` : ""}.`
              : "Not changed yet: the defaults."}
          </p>
          <p>
            <button type="submit" className="tonal-button" disabled={busy || !!problem || unchanged}>
              {busy ? "Saving…" : "Save"}
            </button>
          </p>
        </form>
      )}
    </div>
  );
}
