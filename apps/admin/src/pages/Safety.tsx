import { useState } from "react";
import { ApiError, getSafety, handleSos, type SosRow } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PeriodPicker } from "../components/PeriodPicker";
import { Loaded, Empty } from "../components/States";
import { useToast } from "../components/Toast";
import { periodLabel, periodQuery } from "../lib/period";
import { Link, useRouter, withParams } from "../lib/router";
import { ago, dayAndTime } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

function SosCard({ s, onHandle, link }: { s: SosRow; onHandle: () => void; link: (key: string, id: string) => string }) {
  const open = !s.handledAt;
  return (
    <li className={`sos-card${open ? " open" : ""}`}>
      <div className="sos-head">
        <Chip tone={open ? "red" : "neutral"}>{open ? "Open" : "Handled"}</Chip>
        <strong>
          {dayAndTime(s.createdAt)} <span className="muted">({ago(s.createdAt)})</span>
        </strong>
      </div>
      <dl className="facts compact">
        <div>
          <dt>Rider</dt>
          <dd>
            <Link to={link("rider", s.rider.id)}>{s.rider.name}</Link> <span className="muted num">{s.rider.maskedPhone}</span>
          </dd>
        </div>
        <div>
          <dt>Ride</dt>
          <dd>
            <Link to={link("ride", s.rideId)}>{s.route}</Link>
            {s.driver ? <span className="muted"> · driver {s.driver.name}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd className="num">{s.latitude !== null && s.longitude !== null ? `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)} (the car's last position)` : "Not known (no live car position)"}</dd>
        </div>
        <div>
          <dt>Who was told</dt>
          <dd>
            {s.hasContact ? (s.smsDelivered ? "Emergency contact texted" : "Emergency contact: the text failed") : "No emergency contact saved"} ·{" "}
            {s.supportNotified ? "Support texted" : "Support text failed"}
          </dd>
        </div>
        {s.handledAt ? (
          <div>
            <dt>Handled</dt>
            <dd>
              {s.handledBy?.name}, {dayAndTime(s.handledAt)}: “{s.handledNote}”
            </dd>
          </div>
        ) : null}
      </dl>
      {open ? (
        <button type="button" className="primary-button" onClick={onHandle}>
          Mark handled
        </button>
      ) : null}
    </li>
  );
}

/** Safety: open SOS alerts first (red), then handled ones; then 1–2 star ratings with their comments. */
export function SafetyPage() {
  const token = useToken();
  const toast = useToast();
  const { refreshSummary } = useShell();
  const { path, search } = useRouter();
  const [period, setPeriod] = usePagePeriod("safety", "this-month");
  const query = periodQuery(period);
  const data = usePolled(() => getSafety(token, query), query);
  const [handling, setHandling] = useState<SosRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = (key: string, id: string) => withParams(path, search, { [key]: id });

  return (
    <Page title="Safety" subtitle="SOS alerts and low ratings" controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} choices={["this-week", "last-week", "this-month", "last-30", "all-time"]} />
        <span className="muted">{periodLabel(period)} (open SOS from any date)</span>
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => (
          <>
            <Section title={d.openCount ? `${d.openCount} open SOS` : "SOS"}>
              {d.sos.length === 0 ? (
                <Empty>No SOS in this period, and none open.</Empty>
              ) : (
                <ul className="sos-list">
                  {d.sos.map((s) => (
                    <SosCard key={s.id} s={s} link={link} onHandle={() => setHandling(s)} />
                  ))}
                </ul>
              )}
              {d.earlierSos.length ? (
                <p className="muted small">
                  Also {d.earlierSos.length} SOS from before SOS records began (only their tracking link is known):{" "}
                  {d.earlierSos.map((e, i) => (
                    <span key={e.rideId}>
                      {i ? ", " : ""}
                      <Link to={link("ride", e.rideId)}>
                        {e.riderName}, {dayAndTime(e.createdAt)}
                      </Link>
                    </span>
                  ))}
                  .
                </p>
              ) : null}
            </Section>
            <Section title="Low ratings (1–2 stars)">
              {d.lowRatings.length === 0 ? (
                <Empty>No 1 or 2 star ratings in this period.</Empty>
              ) : (
                <ul className="plain-list ratings">
                  {d.lowRatings.map((r) => (
                    <li key={r.id}>
                      <span className="stars" aria-label={`${r.stars} out of 5 stars`}>
                        {"★".repeat(r.stars)}
                        <span className="stars-off">{"★".repeat(5 - r.stars)}</span>
                      </span>{" "}
                      <strong>{r.rater.name}</strong> rated {r.ratee.role === "DRIVER" && r.ratee.driverId ? <Link to={link("driver", r.ratee.driverId)}>{r.ratee.name}</Link> : r.ratee.name} ·{" "}
                      <Link to={link("ride", r.rideId)}>{dayAndTime(r.createdAt)}</Link>
                      {r.comment ? <q className="block"> {r.comment}</q> : <span className="muted"> · no comment</span>}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
            <p className="muted small">
              Admin sign-ins are in <Link to="/settings#logins">Settings</Link>.
            </p>
          </>
        )}
      </Loaded>
      {handling ? (
        <ConfirmDialog
          title={`Mark ${handling.rider.name}'s SOS handled?`}
          confirmLabel="Mark handled"
          reasonLabel="What was done (saved in the audit log)"
          reasonPlaceholder="e.g. Called the rider at 6:20 pm; she is home safe"
          busy={busy}
          error={error}
          onCancel={() => {
            setHandling(null);
            setError(null);
          }}
          onConfirm={async (note) => {
            setBusy(true);
            setError(null);
            try {
              await handleSos(token, handling.id, note);
              toast("SOS marked handled");
              setHandling(null);
              data.refresh();
              refreshSummary();
            } catch (err) {
              setError(err instanceof ApiError ? err.message : "That didn't save");
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </Page>
  );
}
