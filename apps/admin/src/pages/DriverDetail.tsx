import { useState } from "react";
import { ApiError, getDriverDetail, getDriverTrail, suspendDriver, unsuspendDriver, type TrailPoint } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import { DetailDrawer } from "../components/DetailDrawer";
import { StatTile } from "../components/StatTile";
import { Loaded } from "../components/States";
import { useToast } from "../components/Toast";
import { CampusMap } from "../map/CampusMap";
import { RouteLine, StopMarker } from "../map/Markers";
import { cedis, percent } from "../lib/money";
import { OFFER_OUTCOME_LABELS, SESSION_END_LABELS } from "../lib/labels";
import { periodLabel, periodQuery } from "../lib/period";
import { Link, useRouter, withParams } from "../lib/router";
import { clock, dayAndTime, duration, hours, shortDay } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { useShell } from "../shell/ShellContext";
import { rideColumns } from "./rideColumns";

function Trail({ driverId, days }: { driverId: string; days: string[] }) {
  const token = useToken();
  const [day, setDay] = useState(days[0] ?? "");
  const [points, setPoints] = useState<TrailPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (days.length === 0) return <p className="muted small">No location trail in the last 90 days.</p>;
  return (
    <div className="trail">
      <form
        className="filters"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setPoints((await getDriverTrail(token, driverId, day)).points);
          } catch (err) {
            setError(err instanceof ApiError ? err.message : "Couldn't load the trail");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>Day</span>
          <select value={day} onChange={(e) => setDay(e.target.value)}>
            {days.map((d) => (
              <option key={d} value={d}>
                {shortDay(`${d}T12:00:00Z`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="tonal-button" disabled={busy}>
          {busy ? "Loading…" : "See location trail"}
        </button>
      </form>
      <p className="muted small">Viewing a trail is recorded in the audit log with your name.</p>
      {error ? <p className="error-text">{error}</p> : null}
      {points ? (
        points.length === 0 ? (
          <p className="muted">No points that day.</p>
        ) : (
          <>
            <CampusMap label={`Where the driver was on ${shortDay(`${day}T12:00:00Z`)}: ${points.length} points`} height={300} fit={points}>
              {({ p, k }) => (
                <>
                  <RouteLine p={p} points={points} className="map-trail" />
                  <RouteLine p={p} points={points.filter((x) => x.onTrip)} className="map-trail on-trip" />
                  <StopMarker p={p} k={k} latitude={points[0]!.latitude} longitude={points[0]!.longitude} kind="pickup" label={`First point, ${clock(points[0]!.at)}`} />
                  <StopMarker p={p} k={k} latitude={points[points.length - 1]!.latitude} longitude={points[points.length - 1]!.longitude} kind="dropoff" label={`Last point, ${clock(points[points.length - 1]!.at)}`} />
                </>
              )}
            </CampusMap>
            <p className="muted small">
              {points.length} points from {clock(points[0]!.at)} to {clock(points[points.length - 1]!.at)}. Darker line: on a trip.
            </p>
          </>
        )
      ) : null}
    </div>
  );
}

/** One driver: car, the period's earnings and stats, what they owe, trips, online sessions, offers, location trail, suspend. */
export function DriverDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const token = useToken();
  const toast = useToast();
  const { refreshSummary } = useShell();
  const { path, search, navigate } = useRouter();
  const [period] = usePagePeriod("drivers", "this-week");
  const query = periodQuery(period);
  const detail = usePolled(() => getDriverDetail(token, id, query), `driver:${id}:${query}`);
  const [confirm, setConfirm] = useState<"suspend" | "unsuspend" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;

  const act = async (reason: string) => {
    if (!d || !confirm) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm === "suspend") await suspendDriver(token, d.driver.driverId, reason);
      else await unsuspendDriver(token, d.driver.driverId, reason);
      toast(confirm === "suspend" ? `${d.driver.name} is suspended` : `${d.driver.name} can go online again`);
      setConfirm(null);
      detail.refresh();
      refreshSummary();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  const car = d ? [d.driver.carMake, d.driver.carModel].filter(Boolean).join(" ") : "";
  return (
    <DetailDrawer title={d?.driver.name ?? "Driver"} subtitle={d ? [car, d.driver.carColor?.toLowerCase(), d.driver.plate].filter(Boolean).join(" · ") : undefined} onClose={onClose} wide>
      <Loaded {...detail} onRetry={detail.refresh} what="Loading the driver…">
        {(x) => (
          <div className="detail-stack">
            <div className="driver-head">
              {x.driver.photoUrl ? <img className="driver-photo" src={x.driver.photoUrl} alt={`${x.driver.name}'s car`} /> : null}
              <dl className="facts">
                <div>
                  <dt>Phone</dt>
                  <dd className="num">{x.driver.phone ?? "Account closed"}</dd>
                </div>
                <div>
                  <dt>Joined</dt>
                  <dd>{shortDay(x.driver.joinedAt)}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {x.driver.suspendedAt ? (
                      <Chip tone="red">Suspended</Chip>
                    ) : !x.driver.isApproved ? (
                      <Chip tone="amber">Needs approval</Chip>
                    ) : x.driver.isOnline ? (
                      <Chip tone="green">Online</Chip>
                    ) : (
                      <Chip>Offline</Chip>
                    )}
                  </dd>
                </div>
                {x.driver.suspendedAt ? (
                  <div>
                    <dt>Why suspended</dt>
                    <dd>
                      {x.driver.suspendedReason} <span className="muted">({dayAndTime(x.driver.suspendedAt)})</span>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>

            <div className="hero">
              <span className="hero-label">{periodLabel(period)}</span>
              <span className="hero-value num">{cedis(x.period.earnedPesewas)}</span>
              <span className="hero-note">
                {x.period.trips} {x.period.trips === 1 ? "trip" : "trips"} · {hours(x.period.hoursOnlineMs)} online · {cedis(x.period.commissionPesewas)} to CampusRide
                {x.balance.balancePesewas > 0 ? ` · ${cedis(x.balance.balancePesewas)} still owed in all` : " · nothing owed"}
              </span>
            </div>

            <div className="tiles tiles-2">
              <StatTile label="Accepted" value={x.period.acceptanceRate === null ? null : percent(x.period.acceptanceRate)} note={`${x.period.accepted} of ${x.period.accepted + x.period.declined + x.period.timedOut} answered`} />
              <StatTile label="Avg reply" value={x.period.avgReplyMs === null ? null : duration(x.period.avgReplyMs)} />
              <StatTile label="Cancelled by driver" value={String(x.period.cancelledByDriver)} />
              <StatTile label="Rating" value={x.rating === null ? null : x.rating.toFixed(1)} note={x.ratings ? `${x.ratings} ratings, all time` : undefined} />
            </div>

            <div className="button-row">
              <Link to={`/cash?driverId=${x.driver.userId}`} className="tonal-button">
                Cash owed and payments
              </Link>
              {x.driver.suspendedAt ? (
                <button type="button" className="tonal-button" onClick={() => setConfirm("unsuspend")}>
                  Lift suspension
                </button>
              ) : x.driver.isApproved ? (
                <button type="button" className="danger-text-button" onClick={() => setConfirm("suspend")}>
                  Suspend driver
                </button>
              ) : null}
            </div>

            <h3>Recent trips</h3>
            <DataTable columns={rideColumns({ compact: "driver" })} rows={x.recentTrips} rowKey={(r) => r.id} onRowClick={(r) => navigate(withParams(path, search, { driver: null, ride: r.id }))} rowLabel={(r) => `Open ride by ${r.rider.name}`} empty="No trips yet." pageSize={10} />

            <h3>Online sessions</h3>
            {x.sessions.length === 0 ? (
              <p className="muted">Not online in this period.</p>
            ) : (
              <ul className="plain-list">
                {x.sessions.map((s, i) => (
                  <li key={i}>
                    <span className="num">
                      {dayAndTime(s.startedAt)} – {s.endedAt ? clock(s.endedAt) : "now"}
                    </span>{" "}
                    <span className="muted">
                      {duration(s.ms)}
                      {s.endReason ? ` · ${SESSION_END_LABELS[s.endReason] ?? s.endReason}` : " · still online"}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <h3>Offers</h3>
            {x.offers.length === 0 ? (
              <p className="muted">No offers in this period.</p>
            ) : (
              <ul className="plain-list">
                {x.offers.map((o) => (
                  <li key={o.rideId}>
                    <Link to={withParams(path, search, { driver: null, ride: o.rideId })}>{dayAndTime(o.offeredAt)}</Link> · {o.outcome ? OFFER_OUTCOME_LABELS[o.outcome] : "Open"}
                    {o.responseMs !== null && (o.outcome === "ACCEPTED" || o.outcome === "DECLINED") ? <span className="muted"> in {duration(o.responseMs)}</span> : null}
                  </li>
                ))}
              </ul>
            )}

            <h3>Location trail</h3>
            <Trail driverId={x.driver.driverId} days={x.trailDays} />
          </div>
        )}
      </Loaded>
      {confirm && d ? (
        <ConfirmDialog
          title={confirm === "suspend" ? `Suspend ${d.driver.name}?` : `Lift ${d.driver.name}'s suspension?`}
          confirmLabel={confirm === "suspend" ? "Suspend" : "Lift suspension"}
          danger={confirm === "suspend"}
          reasonLabel={confirm === "suspend" ? "Why (saved in the audit log)" : "Why (saved in the audit log)"}
          reasonPlaceholder={confirm === "suspend" ? "e.g. Two complaints about speeding this week" : "e.g. Spoke to the driver; warned"}
          busy={busy}
          error={error}
          onCancel={() => {
            setConfirm(null);
            setError(null);
          }}
          onConfirm={(reason) => void act(reason)}
        >
          {confirm === "suspend" ? (
            <p>They go offline at once and can&apos;t go online until you lift the suspension. A trip they&apos;re on now carries on. Their approval stays.</p>
          ) : (
            <p>They&apos;ll be able to go online again.</p>
          )}
        </ConfirmDialog>
      ) : null}
    </DetailDrawer>
  );
}
