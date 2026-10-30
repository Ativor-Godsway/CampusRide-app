import { useEffect, useState } from "react";
import {
  BROADCAST_AUDIENCE_LABELS,
  BROADCAST_BODY_MAX,
  BROADCAST_TITLE_MAX,
  GHANA_PHONE_EXAMPLE,
  checkBroadcastText,
  normalizeGhanaPhone,
  type BroadcastAudience,
} from "@rida/shared";
import {
  ApiError,
  getBroadcasts,
  previewAudience,
  sendBroadcast,
  sendTestToMe,
  type AudiencePreview,
  type Broadcast,
  type BroadcastHistory,
} from "../api";
import { useAuth, useToken } from "../auth";

const AUDIENCES: BroadcastAudience[] = ["RIDERS", "DRIVERS", "EVERYONE", "PHONE"];

/** What the confirm box shows: exactly what will be sent, and to how many installs. */
interface Pending {
  audience: BroadcastAudience;
  phone: string | undefined;
  title: string;
  body: string;
  preview: AudiencePreview;
}

const STATUS_LABEL: Record<Broadcast["status"], string> = {
  SENDING: "Sending…",
  SENT: "Sent",
  FAILED: "Failed",
  INTERRUPTED: "Interrupted",
};

const STATUS_BADGE: Record<Broadcast["status"], string> = {
  SENDING: "badge",
  SENT: "badge badge-completed",
  FAILED: "badge badge-cancelled",
  INTERRUPTED: "badge badge-cancelled",
};

/**
 * Notifications: write a push notification and send it to all riders, all
 * drivers, everyone, or one number's account; see every send so far. The
 * server caps sends per hour and audit-logs each one.
 */
export function NotificationsScreen() {
  const token = useToken();
  const { signOut } = useAuth();
  const [history, setHistory] = useState<BroadcastHistory | null>(null);
  const [audience, setAudience] = useState<BroadcastAudience>("RIDERS");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
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
    setHistory(await getBroadcasts(token));
  }

  useEffect(() => {
    void run(load);
    // Once, on opening the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While a send is still going out, refresh the history every few seconds.
  const sending = history?.broadcasts.some((b) => b.status === "SENDING") ?? false;
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => {
      getBroadcasts(token).then(setHistory, () => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [sending, token]);

  /** The text as it will be sent, or null after showing why it can't be. */
  function checkedText() {
    const checked = checkBroadcastText({ title, body });
    if (!checked.ok) {
      setError(checked.error);
      return null;
    }
    return checked.text;
  }

  function review(event: React.FormEvent) {
    event.preventDefault();
    const text = checkedText();
    if (!text) return;
    let canonical: string | undefined;
    if (audience === "PHONE") {
      canonical = normalizeGhanaPhone(phone) ?? undefined;
      if (!canonical) {
        setError(GHANA_PHONE_EXAMPLE);
        return;
      }
    }
    void run(async () => {
      const preview = await previewAudience(token, audience, canonical ?? "");
      setPending({ audience, phone: canonical, ...text, preview });
    });
  }

  function confirmSend() {
    if (!pending) return;
    void run(async () => {
      const { broadcast } = await sendBroadcast(token, {
        audience: pending.audience,
        phone: pending.phone,
        title: pending.title,
        body: pending.body,
      });
      setPending(null);
      setTitle("");
      setBody("");
      await load();
      setNotice(
        broadcast.devices === 0
          ? "Recorded, but no device had notifications allowed, so nothing went out."
          : `Sending to ${broadcast.devices} device(s). The counts below update as it goes.`,
      );
    });
  }

  function testToMe() {
    const text = checkedText();
    if (!text) return;
    void run(async () => {
      const result = await sendTestToMe(token, text);
      await load();
      setNotice(result.message);
    });
  }

  const caps = history?.caps;
  const recipient = pending?.preview.recipient;

  return (
    <section>
      <div className="section-head">
        <h2>Notifications</h2>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(load)}>
          Refresh
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}

      <div className="card settings-card">
        <h3>New notification</h3>
        <p className="muted small">
          Goes to every phone signed in to the app with notifications allowed. Review demo accounts
          never get one.
          {caps
            ? ` This hour: ${caps.broadcast.used} of ${caps.broadcast.max} sends to all riders, all drivers or everyone; ${caps.direct.used} of ${caps.direct.max} single-number and test sends (all admins together).`
            : null}
        </p>

        <form className="settings-form" onSubmit={review}>
          <div>
            <label htmlFor="notify-title">
              Title <span className="muted small">({title.trim().length}/{BROADCAST_TITLE_MAX})</span>
            </label>
            <input
              id="notify-title"
              value={title}
              maxLength={BROADCAST_TITLE_MAX}
              onChange={(e) => {
                setTitle(e.target.value);
                setPending(null);
              }}
              required
            />
          </div>
          <div>
            <label htmlFor="notify-body">
              Message <span className="muted small">({body.trim().length}/{BROADCAST_BODY_MAX})</span>
            </label>
            <textarea
              id="notify-body"
              rows={3}
              value={body}
              maxLength={BROADCAST_BODY_MAX}
              onChange={(e) => {
                setBody(e.target.value);
                setPending(null);
              }}
              required
            />
          </div>

          <fieldset className="notify-audience">
            <legend>Send to</legend>
            {AUDIENCES.map((a) => (
              <label key={a} className="settings-option">
                <input
                  type="radio"
                  name="notify-audience"
                  value={a}
                  checked={audience === a}
                  onChange={() => {
                    setAudience(a);
                    setPending(null);
                  }}
                />
                <span>{BROADCAST_AUDIENCE_LABELS[a]}</span>
              </label>
            ))}
          </fieldset>

          {audience === "PHONE" ? (
            <div>
              <label htmlFor="notify-phone">Phone number</label>
              <input
                id="notify-phone"
                type="tel"
                placeholder="0XXXXXXXXX"
                value={phone}
                onChange={(e) => {
                  setPhone(e.target.value);
                  setPending(null);
                }}
                required
              />
            </div>
          ) : null}

          <p className="notify-actions">
            <button type="submit" disabled={busy || pending !== null}>
              Review and send…
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={testToMe}>
              Send test to me
            </button>
          </p>
        </form>

        {pending ? (
          <div className="notify-confirm" role="alertdialog" aria-labelledby="notify-confirm-title">
            <h4 id="notify-confirm-title">
              Send to {BROADCAST_AUDIENCE_LABELS[pending.audience].toLowerCase()}
              {recipient ? ` (${recipient.name}, ${recipient.role.toLowerCase()}, ${recipient.maskedPhone})` : ""}?
            </h4>
            <p>
              <strong>{pending.preview.devices}</strong> device(s) will get it right now.
              {pending.preview.devices === 0 ? " Nobody in this audience has notifications allowed." : null}
            </p>
            <div className="notify-preview">
              <strong>{pending.title}</strong>
              <span>{pending.body}</span>
            </div>
            <p className="notify-actions">
              <button type="button" className="danger" disabled={busy} onClick={confirmSend}>
                {busy ? "Sending…" : "Send now"}
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>
                Cancel
              </button>
            </p>
          </div>
        ) : null}
      </div>

      <h3>History</h3>
      {!history ? (
        <p className="muted">Loading…</p>
      ) : history.broadcasts.length === 0 ? (
        <p className="muted">Nothing sent yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Sent by</th>
                <th>Audience</th>
                <th>Text</th>
                <th>Devices</th>
                <th>Delivered</th>
                <th>Failed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.broadcasts.map((b) => (
                <tr key={b.id}>
                  <td>{new Date(b.createdAt).toLocaleString()}</td>
                  <td>{b.sentBy ? b.sentBy.name : <span className="muted">Server</span>}</td>
                  <td>
                    {b.audienceLabel}
                    {b.maskedPhone ? <div className="muted small">{b.maskedPhone}</div> : null}
                  </td>
                  <td>
                    <strong>{b.title}</strong>
                    <div className="small">{b.body}</div>
                  </td>
                  <td>{b.devices}</td>
                  <td>{b.delivered}</td>
                  <td>{b.failed}</td>
                  <td>
                    <span className={STATUS_BADGE[b.status]}>{STATUS_LABEL[b.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">
        Delivered means Expo&apos;s push service accepted it for the phone. If Apple or Google
        refuse it afterwards (reported about 15 minutes later), it moves to Failed. Phones that
        uninstalled the app are removed from the list.
      </p>
    </section>
  );
}
