import { getSupplyDemand, type ZoneSupply } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { HeatGrid } from "../charts/HeatGrid";
import { LineChart } from "../charts/LineChart";
import { count, percent } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter } from "../lib/router";
import { duration, hourLabel } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { DAY_HOURS, changeLine } from "./Overview";

/** The verdict as a chip: "Need 2 more drivers 4–7 pm" (red from 2, amber for 1) or "OK". */
export function verdictChip(z: Pick<ZoneSupply, "need" | "window">): { label: string; tone: "red" | "amber" | "green" } {
  if (z.need <= 0 || !z.window) return { label: "OK", tone: "green" };
  return { label: `Need ${z.need} more ${z.need === 1 ? "driver" : "drivers"} ${z.window}`, tone: z.need >= 2 ? "red" : "amber" };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Most on Fri and Sat evenings" from the heat grid (the two days with the most). */
export function whenMost(grid: number[][]): string | null {
  const perDay = grid.map((row) => row.reduce((s, v) => s + v, 0));
  const total = perDay.reduce((s, v) => s + v, 0);
  if (total === 0) return null;
  const days = perDay
    .map((n, d) => ({ n, d }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.d - b.d)
    .slice(0, 2)
    .sort((a, b) => a.d - b.d)
    .map((x) => WEEKDAYS[x.d]);
  const hours = new Array<number>(24).fill(0);
  for (const row of grid) row.forEach((v, h) => (hours[h]! += v));
  const peak = hours.indexOf(Math.max(...hours));
  const part = peak < 12 ? "mornings" : peak < 17 ? "afternoons" : "evenings";
  return `Most on ${days.join(" and ")} ${part}`;
}

/**
 * Supply & demand: do riders get drivers, how fast, and where and when they
 * don't — with a verdict per pickup zone and one plain suggestion. The rule
 * is in docs/admin-metrics.md.
 */
export function SupplyDemandPage() {
  const token = useToken();
  const { search, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("supply", "this-week");
  const showAll = search.get("heat") === "all";
  const query = periodQuery(period);
  const data = usePolled(() => getSupplyDemand(token, query), query);

  return (
    <Page title="Supply & demand" subtitle="Do I need more drivers, and when?" controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} />
        <span className="muted">{periodLabel(period)}</span>
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => {
          const change = changeLine(d.requests, d.previousRequests, "a week earlier");
          return (
            <>
              {d.suggestion ? (
                <div className="alert alert-amber">
                  <strong>Suggestion:</strong>
                  <span>{d.suggestion}</span>
                </div>
              ) : d.requests > 0 ? (
                <div className="alert alert-green">
                  <strong>No changes needed.</strong>
                  <span>Riders got drivers in every zone and time window.</span>
                </div>
              ) : null}
              <TileRow>
                <StatTile label="Requests" value={count(d.requests)} note={change.text} noteTone={change.tone} />
                <StatTile label="Got a driver" value={d.gotDriverRate === null ? null : percent(d.gotDriverRate)} note={`${d.gotDriver} of ${d.requests}`} />
                <StatTile label="Time to get a driver" value={d.medianTimeToDriverMs === null ? null : duration(d.medianTimeToDriverMs)} note="Median, requests that got one" />
                <StatTile label="No driver found" value={count(d.noDriver)} note={whenMost(d.heat.noDriver) ?? "None in this period"} noteTone={d.noDriver > 0 ? "warn" : undefined} />
              </TileRow>

              <Section
                title={showAll ? "When riders asked for rides" : "When riders couldn't get a driver"}
                actions={
                  <div className="segmented small" role="group" aria-label="Heat grid shows">
                    <button type="button" className={showAll ? "seg" : "seg active"} aria-pressed={!showAll} onClick={() => setParams({ heat: null }, { replace: true })}>
                      No driver found
                    </button>
                    <button type="button" className={showAll ? "seg active" : "seg"} aria-pressed={showAll} onClick={() => setParams({ heat: "all" }, { replace: true })}>
                      All requests
                    </button>
                  </div>
                }
              >
                <HeatGrid
                  values={showAll ? d.heat.requests : d.heat.noDriver}
                  hours={DAY_HOURS}
                  hourLabels={DAY_HOURS.map((h) => (h === 7 || h === 12 ? hourLabel(h) : hourLabel(h, false)))}
                  what={showAll ? "requests" : "unanswered"}
                  summary={`${showAll ? "Requests" : "Requests with no driver found"} by weekday and hour, 7 am to 11 pm.`}
                />
              </Section>

              <Section title="Requests vs driver-hours online, by hour">
                <LineChart
                  series={[
                    { label: "Requests", color: "var(--green-500)", values: DAY_HOURS.map((h) => d.hourly.requests[h] ?? 0) },
                    { label: "Driver-hours online", color: "var(--amber-700)", values: DAY_HOURS.map((h) => Math.round((d.hourly.driverHours[h] ?? 0) * 10) / 10) },
                  ]}
                  labels={DAY_HOURS.map((h) => hourLabel(h))}
                  summary="Requests and driver-hours online for each hour of the day, added up over the period."
                />
              </Section>

              <Section title="By pickup zone">
                <DataTable
                  columns={[
                    { key: "zone", header: "Zone", render: (z) => <strong>{z.name}</strong>, sortValue: (z) => z.name },
                    { key: "requests", header: "Requests", render: (z) => <span className="num">{z.requests}</span>, sortValue: (z) => z.requests, align: "right" },
                    { key: "nodriver", header: "No driver", render: (z) => <span className="num">{z.noDriver}</span>, sortValue: (z) => z.noDriver, align: "right" },
                    { key: "time", header: "Time to driver", render: (z) => <span className="num">{duration(z.medianTimeToDriverMs)}</span>, sortValue: (z) => z.medianTimeToDriverMs, align: "right" },
                    {
                      key: "verdict",
                      header: "Verdict",
                      render: (z) => {
                        const v = verdictChip(z);
                        const more = z.windows.slice(1).map((w) => `also ${w.need} ${w.label}`).join("; ");
                        return (
                          <Chip tone={v.tone} title={more || undefined}>
                            {v.label}
                          </Chip>
                        );
                      },
                      sortValue: (z) => z.need,
                    },
                  ]}
                  rows={d.zones}
                  rowKey={(z) => z.zoneId}
                  empty="No requests in this period."
                  initialSort={{ key: "requests", dir: "desc" }}
                />
                <p className="muted small">
                  A zone needs more drivers in a 3-hour window when at least 3 requests were made there and 15% or more found no driver. How many: the unanswered
                  requests divided by the trips one online driver completed per hour in that window (at least 1), at most 5. See docs/admin-metrics.md.
                </p>
              </Section>
            </>
          );
        }}
      </Loaded>
    </Page>
  );
}
