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
import { ConfirmDialog } from "../components/ConfirmDialog";

/** One day in the form: the times stay typed in even while "closed all day" is ticked. */
interface DayRow {
  closed: boolean;
  open: string;
  close: string;
}

/** "Today (Saturday): open 08:00–17:00", "Today (Sunday): closed". Ghana time. */
export function todayHoursLine(weekly: (DayHours | null)[], now: number = Date.now()): string {
  const day = new Date(now).getUTCDay();
  const h = weekly[day];
  const name = WEEKDAY_NAMES[day];
  if (!h) return `Today (${name}): closed`;
  return `Today (${name}): open ${h.open}–${h.close === "24:00" ? "midnight" : h.close}`;
}

/** The week in plain words, days with the same hours together ("Mon–Fri 07:00–20:00 · Sat 08:00–17:00 · Sun closed"). */
export function weekLine(weekly: (DayHours | null)[]): string {
  const words = (h: DayHours | null) => (h ? `${h.open}–${h.close === "24:00" ? "midnight" : h.close}` : "closed");
  const parts: Array<{ from: number; to: number; text: string }> = [];
  for (const day of WEEKDAY_ORDER) {
    const text = words(weekly[day] ?? null);
    const last = parts[parts.length - 1];
    if (last && last.text === text) last.to = day;
    else parts.push({ from: day, to: day, text });
  }
  const short = (d: number) => WEEKDAY_NAMES[d]!.slice(0, 3);
  return parts.map((p) => `${p.from === p.to ? short(p.from) : `${short(p.from)}–${short(p.to)}`} ${p.text}`).join(" · ");
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
  const [sameEveryDay, setSameEveryDay] = useState(false);
  const [confirming, setConfirming] = useState<ServiceOverrideMode | "SCHEDULE" | null>(null);

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
    setRows((current) => current.map((r, i) => (sameEveryDay || i === day ? { ...r, ...change } : r)));
  }

  function copyToAll(day: number) {
    setRows((current) => current.map(() => ({ ...current[day]! })));
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
    setConfirming(null);
    void run("Changing service hours", async () => {
      await setServiceOverride(token, mode);
      await load();
    });
  }

  const status = loaded?.status;
  const overrideOn = loaded?.setting.override && status?.reason === "MANUAL";

  return (
    <div className="stack">
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      {notice ? <p className="saved-note">✓ {notice}</p> : null}

      {loaded && status ? (
        <div className="switch-row">
          <span>
            <strong>{loaded.stateLine}</strong>
            <span className="muted small">
              {todayHoursLine(loaded.setting.weekly)} · {loaded.driversOnline} {loaded.driversOnline === 1 ? "driver" : "drivers"} online
              {loaded.waiting > 0 ? ` · ${loaded.waiting} riders want a "we're open" alert` : ""}
            </span>
          </span>
          <div className="button-row" style={{ marginLeft: "auto", flexWrap: "nowrap" }}>
            <button type="button" className="tonal-button" disabled={busy} onClick={() => setConfirming("OPEN")}>
              Open now
            </button>
            <button type="button" className="tonal-button" disabled={busy} onClick={() => setConfirming("CLOSED")}>
              Close now
            </button>
            {overrideOn ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => setConfirming("SCHEDULE")}>
                Back to the schedule
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="muted">Loading…</p>
      )}

      <form onSubmit={save} className="stack">
        <div className="row-between">
          <h3>Weekly hours (Ghana time)</h3>
          <label className="inline">
            <input
              type="checkbox"
              checked={sameEveryDay}
              onChange={(e) => {
                setSameEveryDay(e.target.checked);
                if (e.target.checked && rows.length === 7) copyToAll(1);
              }}
            />
            Same hours every day
          </label>
        </div>
        {rows.length === 7 ? (
          <table className="hours-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Opens</th>
                <th scope="col">Closes</th>
                <th scope="col">Open</th>
                <th scope="col">
                  <span className="sr-only">Copy</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(sameEveryDay ? [1] : WEEKDAY_ORDER).map((day) => {
                const row = rows[day]!;
                const label = sameEveryDay ? "Every day" : WEEKDAY_NAMES[day];
                return (
                  <tr key={day} className={row.closed ? "closed" : undefined}>
                    <td>{label}</td>
                    <td>
                      <input aria-label={`${label} opens`} type="time" value={row.open} disabled={row.closed} onChange={(e) => setRow(day, { open: e.target.value })} />
                    </td>
                    <td>
                      <input
                        aria-label={`${label} closes`}
                        type="time"
                        value={row.close === "24:00" ? "00:00" : row.close}
                        disabled={row.closed}
                        onChange={(e) => setRow(day, { close: e.target.value })}
                      />
                    </td>
                    <td>
                      <button type="button" role="switch" aria-checked={!row.closed} aria-label={`${label} open`} className="big-switch" onClick={() => setRow(day, { closed: !row.closed })} />
                    </td>
                    <td>
                      {sameEveryDay ? null : (
                        <button type="button" className="text-button small" onClick={() => copyToAll(day)}>
                          Copy to all days
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        <p className="muted small">A closing time at or before the opening time runs past midnight (20:00 to 02:00). 00:00 means midnight.</p>

        <label className="field">
          <span>Message while closed (optional)</span>
          <input type="text" maxLength={SERVICE_MESSAGE_MAX} placeholder="Closed for the holiday" value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>

        <div className="switch-row">
          <button type="button" role="switch" aria-checked={blockNoDrivers} aria-label="Block requests when no drivers are online" className="big-switch" onClick={() => setBlockNoDrivers((b) => !b)} />
          <span>
            <strong>Block requests when no drivers are online</strong>
            <span className="muted small">During open hours, riders see &ldquo;No drivers online right now – try again shortly&rdquo; until a driver goes online.</span>
          </span>
        </div>

        <div className="row-between">
          <span className="section-meta">
            {loaded?.setting.updatedAt
              ? `Last changed by ${loaded.setting.updatedBy?.name ?? "an admin"} · ${dayAndTime(loaded.setting.updatedAt)}`
              : "Not changed yet: the default hours apply."}
          </span>
          <button type="submit" className="primary-button" disabled={busy || !loaded}>
            {busy ? "Saving…" : "Save service hours"}
          </button>
        </div>
      </form>
      {confirming ? (
        <ConfirmDialog
          title={confirming === "OPEN" ? "Open CampusRide now?" : confirming === "CLOSED" ? "Close CampusRide now?" : "Back to the weekly schedule?"}
          confirmLabel={confirming === "OPEN" ? "Open now" : confirming === "CLOSED" ? "Close now" : "Use the schedule"}
          danger={confirming === "CLOSED"}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => override(confirming === "SCHEDULE" ? null : confirming)}
        >
          <p>
            {confirming === "CLOSED"
              ? "Riders can't request new rides until the next scheduled opening. Requests already searching and trips going on carry on."
              : confirming === "OPEN"
                ? "Riders can book until the next scheduled closing time, then the schedule takes over by itself."
                : "The weekly hours decide again."}
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
