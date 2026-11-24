import { useEffect, useState } from "react";
import {
  DEFAULT_CLOSE,
  DEFAULT_OPEN,
  SERVICE_MESSAGE_MAX,
  WEEKDAY_NAMES,
  WEEKDAY_ORDER,
  readWeeklySchedule,
  type DayHours,
  type ServiceOverrideMode,
} from "@rida/shared";
import {
  ApiError,
  failureText,
  getServiceHours,
  saveServiceHours,
  setServiceOverride,
  type ServiceHoursSettings,
} from "../api";
import { useAuth, useToken } from "../auth";
import { dayAndTime } from "../lib/time";

/** One day in the form: the times stay typed in even while "closed all day" is ticked. */
interface DayRow {
  closed: boolean;
  open: string;
  close: string;
}

function toRows(weekly: (DayHours | null)[]): DayRow[] {
  return weekly.map((d) => (d ? { closed: false, ...d } : { closed: true, open: DEFAULT_OPEN, close: DEFAULT_CLOSE }));
}

/**
 * Settings → Service hours: when riders can book. A weekly schedule in
 * Ghana time (Africa/Accra, GMT), Open now / Close now until the next
 * scheduled change, an optional closed message, and "Block requests when no
 * drivers are online". Requests already searching and trips going on are
 * never cancelled; review demo accounts always book. Every change is in the
 * audit log, and reaches the apps within seconds.
 */
export function ServiceHoursCard() {
  const token = useToken();
  const { signOut } = useAuth();
  const [loaded, setLoaded] = useState<ServiceHoursSettings | null>(null);
  const [rows, setRows] = useState<DayRow[]>([]);
  const [message, setMessage] = useState("");
  const [blockNoDrivers, setBlockNoDrivers] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setError(failureText(section, err));
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const next = await getServiceHours(token);
    setLoaded(next);
    setRows(toRows(next.setting.weekly));
    setMessage(next.setting.closedMessage ?? "");
    setBlockNoDrivers(next.setting.blockWhenNoDrivers);
  }

  useEffect(() => {
    void run("Loading service hours", load);
    // Once, on opening the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setRow(day: number, change: Partial<DayRow>) {
    setRows((current) => current.map((r, i) => (i === day ? { ...r, ...change } : r)));
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    // A time input can't say 24:00: closing at 00:00 means at midnight, the end of that day.
    const weekly = rows.map((r) => (r.closed ? null : { open: r.open, close: r.close === "00:00" ? "24:00" : r.close }));
    const checked = readWeeklySchedule(weekly);
    if ("error" in checked) {
      setError(checked.error);
      return;
    }
    void run("Saving service hours", async () => {
      await saveServiceHours(token, {
        weekly: checked.weekly,
        closedMessage: message.trim() ? message.trim() : null,
        blockWhenNoDrivers: blockNoDrivers,
      });
      await load();
      setNotice("Saved. Riders' apps update within seconds.");
    });
  }

  function override(mode: ServiceOverrideMode | null) {
    const sentence =
      mode === "CLOSED"
        ? "Close CampusRide now? Riders can't request new rides until the next scheduled opening. Requests already searching and trips going on carry on."
        : mode === "OPEN"
          ? "Open CampusRide now? Riders can book until the next scheduled closing time."
          : "Go back to the weekly schedule?";
    if (!window.confirm(sentence)) return;
    void run("Changing service hours", async () => {
      await setServiceOverride(token, mode);
      await load();
    });
  }

  const status = loaded?.status;
  const overrideOn = loaded?.setting.override && status?.reason === "MANUAL";

  return (
    <div className="inset">
      <h3>Service hours</h3>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      {loaded && status ? (
        <>
          <p>
            <strong>{loaded.stateLine}</strong>
          </p>
          <p className="muted small">
            {loaded.driversOnline} driver(s) online.
            {loaded.waiting > 0 ? ` ${loaded.waiting} rider(s) asked to be notified at the next opening.` : ""}
            {loaded.setting.updatedAt
              ? ` Last changed ${dayAndTime(loaded.setting.updatedAt)}${
                  loaded.setting.updatedBy ? ` by ${loaded.setting.updatedBy.name}` : ""
                }.`
              : " Not changed yet: the default hours apply."}
          </p>
          <p>
            <button type="button" className="tonal-button" disabled={busy} onClick={() => override("OPEN")}>
              Open now
            </button>{" "}
            <button type="button" className="tonal-button" disabled={busy} onClick={() => override("CLOSED")}>
              Close now
            </button>{" "}
            {overrideOn ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => override(null)}>
                Back to the schedule
              </button>
            ) : null}
          </p>
          <p className="muted small">
            Open now and Close now last until the next scheduled change (Close now at 3 PM stays closed until
            tomorrow&apos;s opening), then the schedule takes over by itself.
          </p>
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}

      <form onSubmit={save} className="settings-form">
        <h4>Weekly schedule (Ghana time, GMT)</h4>
        {rows.length === 7
          ? WEEKDAY_ORDER.map((day) => {
              const row = rows[day]!;
              return (
                <div key={day} className="filters">
                  <div>
                    <strong>{WEEKDAY_NAMES[day]}</strong>
                  </div>
                  <div>
                    <label htmlFor={`open-${day}`}>Opens</label>
                    <input
                      id={`open-${day}`}
                      type="time"
                      value={row.open}
                      disabled={row.closed}
                      onChange={(e) => setRow(day, { open: e.target.value })}
                    />
                  </div>
                  <div>
                    <label htmlFor={`close-${day}`}>Closes</label>
                    <input
                      id={`close-${day}`}
                      type="time"
                      value={row.close === "24:00" ? "00:00" : row.close}
                      disabled={row.closed}
                      onChange={(e) => setRow(day, { close: e.target.value })}
                    />
                  </div>
                  <label className="settings-option">
                    <input type="checkbox" checked={row.closed} onChange={(e) => setRow(day, { closed: e.target.checked })} />
                    <span>Closed all day</span>
                  </label>
                </div>
              );
            })
          : null}
        <p className="muted small">
          A closing time at or before the opening time runs past midnight (8:00 PM to 2:00 AM).
        </p>

        <div>
          <label htmlFor="closed-message">Closed message (optional)</label>
          <input
            id="closed-message"
            type="text"
            maxLength={SERVICE_MESSAGE_MAX}
            placeholder="Closed for the holiday"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <p className="muted small">
            Shown to riders whenever CampusRide is closed, with the time it opens again. Clear it when it no longer
            applies.
          </p>
        </div>

        <label className="settings-option">
          <input type="checkbox" checked={blockNoDrivers} onChange={(e) => setBlockNoDrivers(e.target.checked)} />
          <span>
            <strong>Block requests when no drivers are online</strong>
            <span className="muted small">
              {" "}
              During open hours, riders see &ldquo;No drivers online right now – try again shortly&rdquo; until a
              driver goes online.
            </span>
          </span>
        </label>

        <p>
          <button type="submit" className="tonal-button" disabled={busy || !loaded}>
            {busy ? "Saving…" : "Save service hours"}
          </button>
        </p>
      </form>
    </div>
  );
}
