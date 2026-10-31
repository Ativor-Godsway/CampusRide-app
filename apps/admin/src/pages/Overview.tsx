import { getLive, getOverview, type Live, type Overview } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { PairedBars } from "../charts/PairedBars";
import { busiest } from "../charts/math";
import { CampusMap } from "../map/CampusMap";
import { CarMarker, WaitingMarker } from "../map/Markers";
import { cedis, count } from "../lib/money";
import { presetPeriod, periodQuery, comparisonLabel } from "../lib/period";
import { Link, useRouter, withParams } from "../lib/router";
import { hourLabel, longDay } from "../lib/time";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";
import { rideColumns } from "./rideColumns";

/** The hours the dashboard's day charts show: 7 am to 11 pm. */
export const DAY_HOURS = Array.from({ length: 17 }, (_, i) => i + 7);

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

function LiveCard({ live }: { live: Live | null }) {
  return (
    <Section title="Live now" actions={<Link to="/live">Open live map</Link>}>
      <CampusMap compact height={200} label={live ? `Small map of campus with ${live.counts.online} online cars and ${live.counts.ridersWaiting} riders waiting` : "Small map of campus"}>
        {({ p, k }) =>
          live ? (
            <>
              {live.requests.map((r) =>
                r.pickup ? <WaitingMarker key={r.rideId} p={p} k={k * 1.3} latitude={r.pickup.latitude} longitude={r.pickup.longitude} label={`${r.riderName} waiting`} /> : null,
              )}
              {live.drivers.map((d) =>
                d.position ? (
                  <CarMarker key={d.userId} p={p} k={k * 1.3} latitude={d.position.latitude} longitude={d.position.longitude} heading={d.position.heading} onTrip={d.status === "ON_TRIP"} stale={!d.position.live} label={d.name} />
                ) : null,
              )}
            </>
          ) : null
        }
      </CampusMap>
      {live ? (
        <div className="chip-row">
          <Chip tone="green">{live.counts.online} online</Chip>
          <Chip tone="dark">{live.counts.onTrip} on trip</Chip>
          <Chip tone="amber">{live.counts.ridersWaiting} waiting</Chip>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Overview: today at a glance. Alerts only when something needs doing, the
 * day's numbers, requests against drivers online per hour, a small live map
 * and the latest rides.
 */
export function OverviewPage() {
  const token = useToken();
  const { summary } = useShell();
  const { path, search, navigate } = useRouter();
  const today = presetPeriod("today");
  const query = periodQuery(today);
  const overview = usePolled(() => getOverview(token, query), query);
  const live = usePolled(() => getLive(token), "overview-live");

  return (
    <Page
      title="Overview"
      subtitle={longDay(Date.now())}
      controls={<Freshness updatedAt={overview.updatedAt} onRefresh={() => (overview.refresh(), live.refresh())} loading={overview.loading} />}
    >
      <Loaded {...overview} onRetry={overview.refresh} what="Loading today…">
        {(o) => (
          <>
            <div className="alerts">
              {o.noDriver.count > 0 ? (
                <div className="alert alert-amber" role="alert">
                  <strong>
                    {o.noDriver.count} {o.noDriver.count === 1 ? "request" : "requests"} found no driver today{noDriverDetail(o.noDriver) ? "," : "."}
                  </strong>
                  <span>{noDriverDetail(o.noDriver)}</span>
                  <Link to="/supply">See supply &amp; demand</Link>
                </div>
              ) : null}
              {summary && summary.openSos > 0 ? (
                <div className="alert alert-red" role="alert">
                  <strong>
                    {summary.openSos} open SOS {summary.openSos === 1 ? "alert" : "alerts"}
                  </strong>
                  <span>Someone asked for help and nobody has marked it handled.</span>
                  <Link to="/safety">Open Safety</Link>
                </div>
              ) : null}
              {summary && summary.driversNeedingApproval > 0 ? (
                <div className="alert alert-green">
                  <strong>
                    {summary.driversNeedingApproval} {summary.driversNeedingApproval === 1 ? "driver is" : "drivers are"} waiting for approval
                  </strong>
                  <Link to="/drivers?tab=approval">Review drivers</Link>
                </div>
              ) : null}
            </div>

            <TileRow>
              <StatTile label="Rides today" value={count(o.requests.count)} note={changeLine(o.requests.count, o.requests.previousCount, comparisonLabel(today)).text} noteTone={changeLine(o.requests.count, o.requests.previousCount, "").tone} />
              <StatTile
                label="Fares collected (cash)"
                value={cedis(o.completed.faresPesewas)}
                note={`${o.completed.trips} completed · ${o.completed.sharedTrips} shared`}
              />
              <StatTile label="CampusRide 15%" value={cedis(o.completed.commissionPesewas)} note={`${cedis(o.cashOutstandingPesewas)} owed by drivers in total`} />
              <StatTile
                label="Online now"
                value={live.data ? `${live.data.counts.online} ${live.data.counts.online === 1 ? "driver" : "drivers"}` : null}
                note={live.data ? `${live.data.counts.ridersWaiting} ${live.data.counts.ridersWaiting === 1 ? "rider" : "riders"} waiting · ${live.data.counts.tripsRunning} ${live.data.counts.tripsRunning === 1 ? "trip" : "trips"} running` : "Loading…"}
              />
            </TileRow>

            <div className="grid-2-1">
              <Section title="Requests vs drivers, by hour">
                <PairedBars
                  series={[
                    { label: "Requests", color: "var(--green-500)", values: DAY_HOURS.map((h) => o.hourly.requests[h] ?? 0) },
                    { label: "Drivers online", color: "var(--amber-400)", values: DAY_HOURS.map((h) => o.hourly.driversOnline[h] ?? 0) },
                  ]}
                  labels={DAY_HOURS.map((h) => (h === 7 || h === 12 ? hourLabel(h) : hourLabel(h, false)))}
                  summary={`Ride requests and drivers online per hour today. ${busiestLine(o.hourly.requests, o.hourly.driversOnline)}`}
                />
                <p className="insight">{busiestLine(o.hourly.requests, o.hourly.driversOnline)}</p>
              </Section>
              <LiveCard live={live.data} />
            </div>

            <Section title="Latest rides" actions={<Link to="/rides">All rides</Link>}>
              <DataTable
                columns={rideColumns()}
                rows={o.latestRides}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(withParams(path, search, { ride: r.id }))}
                rowLabel={(r) => `Open ride by ${r.rider.name}`}
                empty="No rides yet."
                pageSize={8}
              />
            </Section>
          </>
        )}
      </Loaded>
    </Page>
  );
}
