import { useEffect, useState } from "react";
import {
  GHANA_PHONE_EXAMPLE,
  countdownParts,
  countdownWords,
  launchClockTime,
  launchDay,
  normalizeGhanaPhone,
} from "@rida/shared";
import {
  ApiError,
  getLaunchSettings,
  giveEarlyAccessToAllRiders,
  lookUpEarlyAccess,
  saveLaunchMode,
  setEarlyAccess,
  type EarlyAccessLookup,
  type LaunchMode,
  type LaunchSettings,
} from "../api";
import { useAuth, useToken } from "../auth";

const MODES: { mode: LaunchMode; title: string; detail: string }[] = [
  { mode: "OFF", title: "Off", detail: "Normal: everyone can ride. No countdown anywhere." },
  {
    mode: "COUNTDOWN",
    title: "Countdown",
    detail:
      "Riders can sign in and look around, but only early-access riders, review demo accounts and admins can book. Everyone else sees a countdown. Becomes Live by itself at the launch time.",
  },
  { mode: "LIVE", title: "Live", detail: "Launched: everyone can ride." },
];

/** "Saturday 14 November 2026 at 9:00 AM GMT". Ghana is on GMT all year. */
function ghanaTime(iso: string): string {
  const at = new Date(iso);
  return `${launchDay(at)} ${at.getUTCFullYear()} at ${launchClockTime(at)} GMT`;
}

/** The date and time inputs' values for an ISO time, in Ghana time (= UTC). */
function toInputs(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "09:00" };
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/**
 * Settings (for now: launch mode). The countdown before the public launch,
 * and who can book during it. Every change here is written to the audit log.
 * Times are Ghana time, GMT.
 */
export function SettingsScreen() {
  const token = useToken();
  const { signOut } = useAuth();
  const [settings, setSettings] = useState<LaunchSettings | null>(null);
  const [mode, setMode] = useState<LaunchMode>("OFF");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [phone, setPhone] = useState("");
  const [lookup, setLookup] = useState<EarlyAccessLookup | null>(null);
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

  async function load() {
    const loaded = await getLaunchSettings(token);
    setSettings(loaded);
    setMode(loaded.setting.mode);
    const inputs = toInputs(loaded.setting.launchAt);
    setDate(inputs.date);
    setTime(inputs.time);
  }

  useEffect(() => {
    void run(load);
    // Once, on opening the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save(event: React.FormEvent) {
    event.preventDefault();
    const launchAt = mode === "COUNTDOWN" && date && time ? `${date}T${time}:00.000Z` : null;
    if (mode === "COUNTDOWN" && !launchAt) {
      setError("Choose the launch date and time.");
      return;
    }
    const sentence =
      mode === "COUNTDOWN"
        ? `Start the countdown to ${ghanaTime(launchAt!)}? Riders without early access won't be able to book until then.`
        : mode === "LIVE"
          ? "Set CampusRide to Live? Everyone will be able to book."
          : "Turn launch mode off? Everyone will be able to book and no countdown is shown.";
    if (!window.confirm(sentence)) return;
    void run(async () => {
      await saveLaunchMode(token, mode, launchAt);
      await load();
      setNotice("Saved. Phones pick it up within a minute.");
    });
  }

  function lookUp(event: React.FormEvent) {
    event.preventDefault();
    const canonical = normalizeGhanaPhone(phone);
    if (!canonical) {
      setError(GHANA_PHONE_EXAMPLE);
      return;
    }
    void run(async () => setLookup(await lookUpEarlyAccess(token, canonical)));
  }

  function toggle(enabled: boolean) {
    if (!lookup?.account) return;
    void run(async () => {
      setLookup(await setEarlyAccess(token, lookup.phone, enabled));
      await load();
    });
  }

  function giveEveryone() {
    if (
      !window.confirm(
        "Give early access to every rider account that exists right now? Riders who sign up later won't get it.",
      )
    )
      return;
    void run(async () => {
      const { granted } = await giveEarlyAccessToAllRiders(token);
      await load();
      setNotice(`Early access given to ${granted} more rider(s).`);
    });
  }

  const status = settings?.status;
  const endedByItself =
    settings?.setting.mode === "COUNTDOWN" && status?.mode === "LIVE" && settings.setting.launchAt;

  return (
    <section>
      <div className="section-head">
        <h2>Settings</h2>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      <div className="card settings-card">
        <h3>Launch mode</h3>
        {status ? (
          <p>
            <strong>In force now: </strong>
            {status.mode === "COUNTDOWN" && status.launchAt ? (
              <>
                Countdown. Opens {ghanaTime(status.launchAt)}, in{" "}
                {countdownWords(
                  countdownParts(Date.parse(status.launchAt) - Date.parse(status.serverTime)),
                )}
                .
              </>
            ) : endedByItself ? (
              <>Live since {ghanaTime(settings.setting.launchAt!)} (the countdown ended by itself).</>
            ) : status.mode === "LIVE" ? (
              "Live."
            ) : (
              "Off."
            )}
          </p>
        ) : (
          <p className="muted">Loading…</p>
        )}
        {settings?.setting.updatedAt ? (
          <p className="muted small">
            Last changed {new Date(settings.setting.updatedAt).toLocaleString()}
            {settings.setting.updatedBy ? ` by ${settings.setting.updatedBy.name}` : ""}.
          </p>
        ) : null}

        <form onSubmit={save} className="settings-form">
          {MODES.map((option) => (
            <label key={option.mode} className="settings-option">
              <input
                type="radio"
                name="launch-mode"
                value={option.mode}
                checked={mode === option.mode}
                onChange={() => setMode(option.mode)}
              />
              <span>
                <strong>{option.title}</strong>
                <span className="muted small"> {option.detail}</span>
              </span>
            </label>
          ))}

          {mode === "COUNTDOWN" ? (
            <div className="filters">
              <div>
                <label htmlFor="launch-date">Launch date</label>
                <input id="launch-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div>
                <label htmlFor="launch-time">Time (Ghana, GMT)</label>
                <input id="launch-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
              </div>
            </div>
          ) : null}

          <p>
            <button type="submit" disabled={busy || !settings}>
              {busy ? "Saving…" : "Save launch mode"}
            </button>
          </p>
        </form>
      </div>

      <div className="card settings-card">
        <h3>Early access</h3>
        <p className="muted">
          Riders with early access can book during the countdown (the pilot testers). Review demo
          accounts and admins always can.{" "}
          {settings ? `${settings.earlyAccessRiders} rider(s) have early access now.` : null}
        </p>
        <p>
          <button type="button" disabled={busy} onClick={giveEveryone}>
            Give early access to all current riders
          </button>
        </p>

        <form className="filters" onSubmit={lookUp}>
          <div>
            <label htmlFor="early-phone">One rider&apos;s phone number</label>
            <input
              id="early-phone"
              type="tel"
              placeholder="0XXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
          </div>
          <button type="submit" disabled={busy || phone.trim().length === 0}>
            Look up
          </button>
        </form>

        {lookup ? (
          lookup.account ? (
            <p>
              <strong>{lookup.phone}</strong>{" "}
              <span className="muted">
                {lookup.account.name} ({lookup.account.role.toLowerCase()}) ·{" "}
                {lookup.account.earlyAccessAt
                  ? `early access since ${new Date(lookup.account.earlyAccessAt).toLocaleDateString()}`
                  : "no early access"}
              </span>{" "}
              {lookup.account.role === "RIDER" ? (
                lookup.account.earlyAccessAt ? (
                  <button type="button" className="secondary" disabled={busy} onClick={() => toggle(false)}>
                    Take away early access
                  </button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => toggle(true)}>
                    Give early access
                  </button>
                )
              ) : null}
            </p>
          ) : (
            <p className="muted">No CampusRide account has {lookup.phone}.</p>
          )
        ) : null}
      </div>
    </section>
  );
}
