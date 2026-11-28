import { getKpis, type Kpis, type Overview } from "../api";
import { useToken } from "../auth";
import { StatTile } from "../components/StatTile";
import { Collapsible } from "../components/Collapsible";
import { Loaded } from "../components/States";
import { PeriodPicker } from "../components/PeriodPicker";
import { BarList } from "../charts/BarList";
import { LineChart } from "../charts/LineChart";
import { PairedBars } from "../charts/PairedBars";
import { busiest } from "../charts/math";
import { cedis, count } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { Link } from "../lib/router";
import { hourLabel, shortDay } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { useInvestorView } from "../lib/useInvestorView";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

/** The hours the dashboard's day charts show: 6 am to 11 pm. */
export const DAY_HOURS = Array.from({ length: 18 }, (_, i) => i + 6);

/** "Busiest at 6 pm: 10 requests, 4 drivers." */
export function busiestLine(requests: number[], drivers: number[]): string {
  const top = busiest(requests);
  if (!top) return "No requests yet today.";
  const d = drivers[top.index] ?? 0;
  return `Busiest at ${hourLabel(top.index)}: ${top.value} ${top.value === 1 ? "request" : "requests"}, ${d} ${d === 1 ? "driver" : "drivers"}.`;
}

/** "+5 on last Saturday", "Same as last Saturday", "−2 on last week". */
export function changeLine(now: number, before: number, against: string): { text: string; tone?: "good" | "bad" } {
  const diff = now - before;
  if (diff === 0) return { text: `Same as ${against}` };
  return { text: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} on ${against}`, tone: diff > 0 ? "good" : "bad" };
}

/** "between 5 pm and 7 pm. Most from Night Market and Commonwealth Hall." */
export function noDriverDetail(n: Overview["noDriver"]): string {
  const when =
    n.firstHour === null ? "" : n.firstHour === n.lastHour ? `around ${hourLabel(n.firstHour)}.` : `between ${hourLabel(n.firstHour)} and ${hourLabel(n.lastHour! + 1)}.`;
  const where = n.topZones.length ? ` Most from ${n.topZones.join(" and ")}.` : "";
  return `${when}${where}`.trim();
}

/** "27%", "—". */
export function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v)}%`;
}

/** "16 s", "1 min 40 s", "—". */
export function seconds(v: number | null): string {
  if (v === null) return "—";
  const s = Math.round(v);
  if (s < 60) return `${s} s`;
  return s % 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s / 60} min`;
}

/** "Mon 23". */
function dayTick(day: string): string {
  return shortDay(`${day}T00:00:00Z`).replace(/ [A-Z][a-z]{2}$/, "");
}

function Funnel({ k }: { k: Kpis }) {
  const top = Math.max(1, k.funnel[0]?.riders ?? 1);
  return (
    <div className="funnel" role="list" aria-label="Rider funnel">
      {k.funnel.map((f, i) => (
        <div className="funnel-row" role="listitem" key={f.step}>
          <span>{f.step}</span>
          <span className="funnel-bar" aria-hidden="true">
            <span className="funnel-fill" style={{ width: `${(100 * f.riders) / top}%`, display: "block" }} />
          </span>
          <span className="funnel-num">
            <strong>{count(f.riders)}</strong> <span className="muted small">{i === 0 ? "" : `${pct(f.pctOfPrevious)} of previous`}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function KpiBody({ k }: { k: Kpis }) {
  const m = k.kpis;
  const days = k.daily;
  const labels = days.map((d) => dayTick(d.day));
  const hours = DAY_HOURS;
  const byHour = new Map(k.byHour.map((h) => [h.hour, h]));
  const busiestHour = busiest(k.byHour.map((h) => h.requests));
  return (
    <>
      <div className="kpi-hero">
        <StatTile dark label="Registered riders" value={count(m.registeredRiders)} note={`+${count(m.newSignups)} new sign-ups in this period`} />
        <StatTile label="Completed rides" value={count(m.completedRides)} note={`${count(m.requests)} requests · ${count(m.seatsCarried)} seats`} />
        <StatTile label="GMV" value={cedis(m.gmvPesewas)} note={m.avgFarePesewas !== null ? `${cedis(m.avgFarePesewas)} average fare` : "Fares on completed rides"} />
        <StatTile label="Completion" value={pct(m.completionPct)} note={`${pct(m.completionPctOfAttempts)} of trip attempts · ${pct(m.noDriverPct)} no driver`} />
      </div>

      <div className="kpi-grid">
        <StatTile label="New sign-ups" value={count(m.newSignups)} note="New rider accounts" />
        <StatTile label="Riders who requested" value={count(m.ridersRequested)} note={m.registeredRiders ? `${pct((100 * m.ridersRequested) / m.registeredRiders)} of registered` : undefined} />
        <StatTile label="Riders served" value={count(m.ridersServed)} note={m.ridersRequested ? `${pct((100 * m.ridersServed) / m.ridersRequested)} of requesters` : undefined} />
        <StatTile label="Repeat riders" value={count(m.repeatRiders)} note={`${pct(m.repeatPct)} of riders served (2+ rides)`} />
        <StatTile label="Requests" value={count(m.requests)} note={`${count(m.tripAttempts)} trip attempts`} />
        <StatTile label={`"No driver found"`} value={pct(m.noDriverPct)} note="Requests auto-closed with no driver" noteTone={m.noDriverPct !== null && m.noDriverPct >= 15 ? "warn" : undefined} />
        <StatTile label="Riders per car trip" value={m.ridersPerCarTrip === null ? null : m.ridersPerCarTrip.toFixed(2)} note={`${count(m.carTrips)} car trips`} />
        <StatTile label="Active drivers" value={count(m.activeDrivers)} note="With 1+ completed car trip" />
        <StatTile label="Median time to accept" value={seconds(m.medianAcceptSeconds)} note={m.medianPickupWaitMin !== null ? `Pickup wait ${m.medianPickupWaitMin.toFixed(1)} min` : undefined} />
      </div>

      <div className="grid-2">
        <Section title="Requests vs completed, per day">
          <PairedBars
            series={[
              { label: "Requests", color: "var(--green-400)", values: days.map((d) => d.requests) },
              { label: "Completed", color: "var(--green-700)", values: days.map((d) => d.completed) },
            ]}
            labels={labels}
            summary={`Requests and completed rides per day: ${days.map((d) => `${d.day} ${d.requests} requested, ${d.completed} completed`).join("; ")}`}
          />
        </Section>
        <Section title="Completion rate, per day">
          <LineChart
            series={[{ label: "Completed %", color: "var(--green-500)", values: days.map((d) => d.completionPct ?? 0) }]}
            labels={labels}
            showEvery={1}
            summary={`Completion rate per day: ${days.map((d) => `${d.day} ${pct(d.completionPct)}`).join("; ")}`}
          />
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Sign-ups per day">
          <PairedBars
            series={[{ label: "New riders", color: "var(--blue-500)", values: days.map((d) => d.signups) }]}
            labels={labels}
            summary={`New rider sign-ups per day: ${days.map((d) => `${d.day} ${d.signups}`).join("; ")}`}
          />
        </Section>
        <Section title="Rides by hour of the day">
          <PairedBars
            series={[
              { label: "Requests", color: "var(--green-400)", values: hours.map((h) => byHour.get(h)?.requests ?? 0) },
              { label: "Completed", color: "var(--green-700)", values: hours.map((h) => byHour.get(h)?.completed ?? 0) },
            ]}
            labels={hours.map((h) => (h % 3 === 0 ? hourLabel(h) : hourLabel(h, false)))}
            summary="Requests and completed rides by hour of the day, Ghana time."
          />
          {busiestHour ? <p className="insight">Busiest hour: {hourLabel(busiestHour.index)}, with {busiestHour.value} requests.</p> : null}
        </Section>
      </div>

      <div className="grid-2">
        <Section title="Rider funnel">
          <p className="card-sub">Registered by the end of the period → requested → got a ride → 2+ rides.</p>
          <Funnel k={k} />
        </Section>
        <Section title="Retention">
          <p className="card-sub">Do riders come back after a ride?</p>
          <div className="tiles-2">
            <StatTile label="Repeat riders" value={pct(k.retention.repeatPct)} note={`${count(k.retention.repeat)} of ${count(k.retention.served)} riders served took 2+ rides`} />
            <StatTile
              label="Came back after a ride"
              value={pct(k.retention.cameBackPct)}
              note={`${count(k.retention.cameBack)} of ${count(k.retention.cameBackBase)} asked again on a later day`}
            />
            <StatTile
              label="Came back without a ride"
              value={pct(k.retention.neverServedCameBackPct)}
              note={`${count(k.retention.neverServedCameBack)} of ${count(k.retention.neverServedBase)} never served`}
            />
            <StatTile label="Commission at the rate" value={cedis(m.commissionAtRatePesewas)} note={`${m.rateBps / 100}% of GMV, what CampusRide would earn`} />
          </div>
        </Section>
      </div>

      <Collapsible id="overview.places" title="Top places" hint="Where most requests start and end in this period." aside={k.topPickups[0]?.name}>
        <div className="grid-2">
          <section className="stack-tight">
            <h3>Pickups</h3>
            <BarList items={k.topPickups.map((p) => ({ label: p.name, value: p.requests }))} summary="Most requested pickup places" />
          </section>
          <section className="stack-tight">
            <h3>Drop-offs</h3>
            <BarList items={k.topDropoffs.map((p) => ({ label: p.name, value: p.requests }))} color="var(--green-400)" summary="Most requested drop-off places" />
          </section>
        </div>
      </Collapsible>

      <p className="muted small">
        Same definitions as the week-1 investor report: test, staging and review-demo accounts and rides are left out. A request is a booking a rider made (not
        a rebook after a driver cancelled); completed = the rider was dropped off; GMV = fares of completed rides, wait fees included; car trip = one car
        journey carrying 1+ riders. Ghana time.
      </p>
    </>
  );
}

/**
 * Overview: the investor screen. The period's KPIs by the week-1 report's
 * definitions (server: services/admin/kpis.ts), charts per day and hour,
 * the rider funnel, retention and the top places. Alerts (SOS, drivers to
 * approve) show above when something needs doing, never in investor view.
 */
export function OverviewPage() {
  const token = useToken();
  const { summary } = useShell();
  const investor = useInvestorView();
  const [period, setPeriod] = usePagePeriod("overview", "since-launch");
  const query = periodQuery(period);
  const kpis = usePolled(() => getKpis(token, query), query, undefined, "Loading the KPIs");

  return (
    <Page
      title="Overview"
      subtitle={periodLabel(period)}
      controls={
        <>
          <PeriodPicker value={period} onChange={setPeriod} choices={["today", "this-week", "since-launch"]} />
          <Freshness updatedAt={kpis.updatedAt} onRefresh={kpis.refresh} loading={kpis.loading} />
        </>
      }
    >
      {!investor.on && summary && (summary.openSos > 0 || summary.driversNeedingApproval > 0) ? (
        <div className="alerts">
          {summary.openSos > 0 ? (
            <div className="alert alert-red" role="alert">
              <strong>
                {summary.openSos} open SOS {summary.openSos === 1 ? "alert" : "alerts"}
              </strong>
              <span>Someone asked for help and nobody has marked it handled.</span>
              <Link to="/safety">Open Safety</Link>
            </div>
          ) : null}
          {summary.driversNeedingApproval > 0 ? (
            <div className="alert alert-green">
              <strong>
                {summary.driversNeedingApproval} {summary.driversNeedingApproval === 1 ? "driver is" : "drivers are"} waiting for approval
              </strong>
              <Link to="/drivers?tab=approval">Review drivers</Link>
            </div>
          ) : null}
        </div>
      ) : null}
      <Loaded {...kpis} onRetry={kpis.refresh} what="Working out the KPIs…">
        {(k) => <KpiBody k={k} />}
      </Loaded>
    </Page>
  );
}
