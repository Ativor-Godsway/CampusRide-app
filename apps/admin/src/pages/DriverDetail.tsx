import { useState } from "react";
import { ApiError, approveDriver, getDriverDetail, getDriverTrail, rejectDriver, suspendDriver, unsuspendDriver, type TrailPoint } from "../api";
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
import { periodFromSearch, periodLabel, periodQuery, periodToSearch, presetPeriod, type Period } from "../lib/period";
import { readPref, writePref } from "../lib/storage";
import { Collapsible } from "../components/Collapsible";
import { PeriodPicker } from "../components/PeriodPicker";
import { CommissionCell, EARNINGS_RANGES } from "./Drivers";
import { Link, useRouter, withParams } from "../lib/router";
import { clock, dayAndTime, duration, hours, humanDay, shortDay } from "../lib/time";
import { PairedBars } from "../charts/PairedBars";
import { useInvestorView } from "../lib/useInvestorView";
import { usePolled } from "../lib/usePolled";
import { useShell } from "../shell/ShellContext";
import { rideColumns } from "./rideColumns";
import { DriverBalancePanel } from "./DriverBalance";

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

/** The driver panel's range (Today / Yesterday / This week / All time / Custom), remembered in this browser. */
function useDetailRange(): [Period, (p: Period) => void] {
  const [period, set] = useState<Period>(() => {
    const saved = readPref("period.driver-detail");
    return (saved && periodFromSearch(new URLSearchParams(saved))) || presetPeriod("this-week");
  });
  return [
    period,
    (p: Period) => {
      writePref("period.driver-detail", new URLSearchParams(periodToSearch(p)).toString());
      set(p);
    },
  ];
}

/**
 * One driver, earnings first: for the range chosen, fares earned,
 * commission (charged / waived), top-ups received and total income, then
 * earnings by day and recent trips. Everything else (performance, what
 * they owe, car and approval, sessions, offers, location trail) is in
 * sections that open on demand.
 */
export function DriverDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const token = useToken();
  const toast = useToast();
  const { refreshSummary } = useShell();
  const { path, search, navigate } = useRouter();
  const [period, setPeriod] = useDetailRange();
  const query = periodQuery(period);
  const detail = usePolled(() => getDriverDetail(token, id, query), `driver:${id}:${query}`);
  const [confirm, setConfirm] = useState<"suspend" | "unsuspend" | "approve" | "reject" | null>(null);
  const investor = useInvestorView();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = detail.data;

  const act = async (reason: string) => {
    if (!d || !confirm) return;
    setBusy(true);
    setError(null);
    try {
      if (confirm === "suspend") await suspendDriver(token, d.driver.driverId, reason);
      else if (confirm === "unsuspend") await unsuspendDriver(token, d.driver.driverId, reason);
      else if (confirm === "approve") await approveDriver(token, d.driver.driverId);
      else await rejectDriver(token, d.driver.driverId, reason);
      toast(
        confirm === "suspend"
          ? `${d.driver.name} is suspended`
          : confirm === "unsuspend"
            ? `${d.driver.name} can go online again`
            : confirm === "approve"
              ? `${d.driver.name} is approved`
              : `${d.driver.name} was not approved`,
      );
      setConfirm(null);
      detail.refresh();
      refreshSummary();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };

  const car = d ? [d.driver.carColor?.toLowerCase(), d.driver.carMake, d.driver.carModel].filter(Boolean).join(" ") : "";
  const status = d
    ? d.driver.suspendedAt
      ? { label: "Suspended", tone: "red" as const }
      : !d.driver.isApproved
        ? { label: "Needs approval", tone: "amber" as const }
        : d.driver.isOnline
          ? { label: "Online", tone: "green" as const }
          : { label: "Offline", tone: "neutral" as const }
    : null;
  return (
    <DetailDrawer
      title={d?.driver.name ?? "Driver"}
      subtitle={
        d ? (
          <>
            {[car, d.driver.plate].filter(Boolean).join(" · ")} {status ? <Chip tone={status.tone}>{status.label}</Chip> : null}
          </>
        ) : undefined
      }
      onClose={onClose}
      wide
    >
      <div className="detail-stack">
        <div className="row-between">
          <PeriodPicker value={period} onChange={setPeriod} choices={EARNINGS_RANGES} />
          <span className="muted small">{periodLabel(period)}</span>
        </div>
        <Loaded {...detail} onRetry={detail.refresh} what="Loading the driver…">
          {(x) => {
            const charged = x.period.commissionPesewas;
            const waived = x.period.commissionWaivedPesewas ?? 0;
            const days = x.byDay ?? [];
            return (
              <>
                <div className="kpi-4">
                  <StatTile label="Fares earned" value={cedis(x.period.faresPesewas)} note={`${x.period.trips} ${x.period.trips === 1 ? "trip" : "trips"} · ${x.period.riders ?? 0} riders`} />
                  <StatTile label="Commission" value={cedis(charged)} note={waived ? `${cedis(waived)} waived` : charged ? "Charged" : "None on these trips"} />
                  <StatTile label="Top-ups received" value={cedis(x.period.topUpsPesewas ?? 0)} note="Paid by CampusRide" />
                  <StatTile
                    dark
                    label="Total income"
                    value={cedis(x.period.incomePesewas ?? x.period.earnedPesewas)}
                    note={`${hours(x.period.hoursOnlineMs)} online${x.period.faresPerOnlineHourPesewas != null ? ` · ${cedis(x.period.faresPerOnlineHourPesewas)} fares/h` : ""}`}
                  />
                </div>

                <section className="stack-tight">
                  <h3>Earnings by day</h3>
                  {days.length === 0 ? (
                    <p className="muted">No trips, top-ups or time online in this range.</p>
                  ) : (
                    <>
                      {days.length > 1 && days.length <= 31 ? (
                        <PairedBars
                          series={[
                            { label: "Fares", color: "var(--green-500)", values: days.map((b) => b.faresPesewas / 100) },
                            { label: "Top-ups", color: "var(--green-400)", values: days.map((b) => b.topUpsPesewas / 100) },
                          ]}
                          labels={days.map((b) => shortDay(`${b.day}T00:00:00Z`).replace(/ [A-Z][a-z]{2}$/, ""))}
                          summary="Fares and top-ups per day, in cedis"
                          height={150}
                        />
                      ) : null}
                      <DataTable
                        columns={[
                          { key: "day", header: "Day", render: (b) => humanDay(b.day), sortValue: (b) => b.day },
                          { key: "trips", header: "Trips", render: (b) => <span className="num">{b.trips}</span>, sortValue: (b) => b.trips, align: "right" },
                          { key: "online", header: "Online", render: (b) => <span className="num">{hours(b.hoursOnlineMs)}</span>, align: "right" },
                          { key: "fares", header: "Fares", render: (b) => <span className="num">{cedis(b.faresPesewas)}</span>, sortValue: (b) => b.faresPesewas, align: "right" },
                          {
                            key: "commission",
                            header: "Commission",
                            render: (b) => <CommissionCell charged={b.commissionDuePesewas} waived={b.commissionWaivedPesewas ?? 0} />,
                            align: "right",
                          },
                          { key: "topups", header: "Top-ups", render: (b) => <span className="num">{b.topUpsPesewas ? cedis(b.topUpsPesewas) : "—"}</span>, align: "right" },
                          {
                            key: "income",
                            header: "Income",
                            render: (b) => <strong className="num">{cedis(b.faresPesewas - b.commissionDuePesewas + b.topUpsPesewas)}</strong>,
                            align: "right",
                          },
                        ]}
                        rows={[...days].reverse()}
                        rowKey={(b) => b.day}
                        pageSize={14}
                      />
                    </>
                  )}
                </section>

                <Collapsible
                  id="driver.recent-trips"
                  defaultOpen
                  title="Recent trips"
                  hint="Their last 10 trips, newest first. Open one for its timeline."
                  aside={<Link to={`/rides?driverId=${x.driver.userId}&period=all-time`}>All their rides</Link>}
                >
                  <DataTable
                    columns={rideColumns({ compact: "driver" })}
                    rows={x.recentTrips}
                    rowKey={(r) => r.id}
                    onRowClick={(r) => navigate(withParams(path, search, { driver: null, ride: r.id }))}
                    rowLabel={(r) => `Open ride by ${r.rider.name}`}
                    empty="No trips yet."
                    pageSize={10}
                  />
                </Collapsible>

                <Collapsible
                  id="driver.performance"
                  title="Performance"
                  hint="How they answer ride offers, pickups they cancelled, and their rating."
                  aside={x.rating === null ? undefined : `${x.rating.toFixed(1)} ★`}
                >
                  <div className="tiles tiles-2">
                    <StatTile label="Accepted" value={x.period.acceptanceRate === null ? null : percent(x.period.acceptanceRate)} note={`${x.period.accepted} of ${x.period.accepted + x.period.declined + x.period.timedOut} answered`} />
                    <StatTile label="Average reply" value={x.period.avgReplyMs === null ? null : duration(x.period.avgReplyMs)} />
                    <StatTile label="Pickups they cancelled" value={String(x.period.cancelledByDriver)} />
                    <StatTile label="Rating" value={x.rating === null ? null : x.rating.toFixed(1)} note={x.ratings ? `${x.ratings} ratings, all time` : undefined} />
                  </div>
                  {x.cancellations?.length ? (
                    <ul className="plain-list">
                      {x.cancellations.map((c, i) => (
                        <li key={i}>
                          <Link to={withParams(path, search, { driver: null, ride: c.rideId })}>{dayAndTime(c.at)}</Link> · {c.riderName} · {c.reasonLabel ?? "no reason given (older app)"}
                          {c.note ? <span className="muted"> “{c.note}”</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </Collapsible>

                <Collapsible
                  id="driver.balance"
                  title="Commission owed"
                  hint="All time: what they owe CampusRide, what they paid, and recording a payment or waiver."
                  aside={x.balance.balancePesewas > 0 ? cedis(x.balance.balancePesewas) : "Nothing owed"}
                >
                  <DriverBalancePanel
                    driver={{ userId: x.driver.userId, name: x.driver.name }}
                    balance={x.balance}
                    onChanged={() => {
                      detail.refresh();
                      refreshSummary();
                    }}
                  />
                </Collapsible>

                <Collapsible id="driver.profile" title="Car, documents and approval" hint="Their car photo and details, phone, when they joined, approval and suspension.">
                  <div className="driver-head">
                    {x.driver.photoUrl ? <img className="driver-photo" src={x.driver.photoUrl} alt={`${x.driver.name}'s car`} /> : <p className="muted">No car photo yet.</p>}
                    <dl className="summary-list">
                      <dt>Car</dt>
                      <dd>{car || "Not given yet"}</dd>
                      <dt>Plate</dt>
                      <dd>{x.driver.plate ?? "Not given yet"}</dd>
                      <dt>Phone</dt>
                      <dd className="num">{x.driver.phone ?? "Account closed"}</dd>
                      <dt>Joined</dt>
                      <dd>{shortDay(x.driver.joinedAt)}</dd>
                      {x.driver.suspendedAt ? (
                        <>
                          <dt>Suspended</dt>
                          <dd>
                            {x.driver.suspendedReason} <span className="muted">({dayAndTime(x.driver.suspendedAt)})</span>
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </div>
                  {investor.on ? null : (
                    <div className="button-row">
                      {!x.driver.isApproved && !x.driver.suspendedAt ? (
                        <>
                          <button type="button" className="primary-button" onClick={() => setConfirm("approve")}>
                            Approve driver
                          </button>
                          <button type="button" className="danger-text-button" onClick={() => setConfirm("reject")}>
                            Don&apos;t approve
                          </button>
                        </>
                      ) : null}
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
                  )}
                </Collapsible>

                <Collapsible id="driver.sessions" title="Online sessions" hint="Each time they went online in this range, and why it ended." aside={hours(x.period.hoursOnlineMs)}>
                  {x.sessions.length === 0 ? (
                    <p className="muted">Not online in this range.</p>
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
                </Collapsible>

                <Collapsible id="driver.offers" title="Ride offers" hint="Every request they were offered in this range and what they did." aside={String(x.period.offers)}>
                  {x.offers.length === 0 ? (
                    <p className="muted">No offers in this range.</p>
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
                </Collapsible>

                <Collapsible id="driver.trail" title="Location trail" hint="Where they drove on a chosen day (kept 90 days). Viewing it is recorded in the audit log.">
                  <Trail driverId={x.driver.driverId} days={x.trailDays} />
                </Collapsible>
              </>
            );
          }}
        </Loaded>
      </div>
      {confirm && d ? (
        <ConfirmDialog
          title={
            confirm === "suspend"
              ? `Suspend ${d.driver.name}?`
              : confirm === "unsuspend"
                ? `Lift ${d.driver.name}'s suspension?`
                : confirm === "approve"
                  ? `Approve ${d.driver.name}?`
                  : `Don't approve ${d.driver.name}?`
          }
          confirmLabel={confirm === "suspend" ? "Suspend" : confirm === "unsuspend" ? "Lift suspension" : confirm === "approve" ? "Approve" : "Don't approve"}
          danger={confirm === "suspend" || confirm === "reject"}
          reasonLabel={confirm === "approve" ? undefined : "Why (saved in the audit log)"}
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
          ) : confirm === "approve" ? (
            <p>They can go online and take rides straight away. Check their car photo and details first.</p>
          ) : confirm === "reject" ? (
            <p>They stay unable to drive. The reason is saved in the audit log.</p>
          ) : (
            <p>They&apos;ll be able to go online again.</p>
          )}
        </ConfirmDialog>
      ) : null}
    </DetailDrawer>
  );
}
