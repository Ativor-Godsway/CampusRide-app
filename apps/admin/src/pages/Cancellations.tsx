import { getCancellations } from "../api";
import { useToken } from "../auth";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { BarList, StackedBar } from "../charts/BarList";
import { PairedBars } from "../charts/PairedBars";
import { count, percent } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter, withParams } from "../lib/router";
import { hourLabel } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { DAY_HOURS } from "./Overview";
import { rideColumns } from "./rideColumns";

const WHO = [
  { value: "", label: "Everyone" },
  { value: "rider", label: "Riders" },
  { value: "driver", label: "Drivers" },
  { value: "system", label: "No driver / expired" },
];

/** Cancellations: how many, who, why, before or after a driver took it, and when. */
export function CancellationsPage() {
  const token = useToken();
  const { path, search, navigate, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("cancellations", "this-week");
  const who = search.get("who") ?? "";
  const query = periodQuery(period);
  const data = usePolled(() => getCancellations(token, query, who || undefined), `${query}|${who}`);

  return (
    <Page title="Cancellations" subtitle={periodLabel(period)} controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => (
          <>
            <TileRow>
              <StatTile label="Cancellations" value={count(d.cancellations)} note={`of ${count(d.requests)} requests`} />
              <StatTile label="Share of requests" value={d.rate === null ? null : percent(d.rate)} />
              <StatTile label="By riders" value={count(d.byWho.rider)} />
              <StatTile label="By drivers" value={count(d.byWho.driver)} noteTone={d.byWho.driver > 0 ? "warn" : undefined} note={d.byWho.driver > 0 ? "After taking the ride" : undefined} />
              <StatTile label="No driver / expired" value={count(d.byWho.system)} />
            </TileRow>
            <div className="grid-2">
              <Section title="Why">
                {d.reasons.length ? (
                  <BarList items={d.reasons.map((r) => ({ label: r.label, value: r.count }))} summary="Cancellations by reason" />
                ) : (
                  <p className="muted">No cancellations in this period.</p>
                )}
              </Section>
              <Section title="Before or after a driver took it">
                <StackedBar
                  parts={[
                    { label: "Before a driver took it", value: d.beforeMatch, color: "var(--amber-400)" },
                    { label: "After", value: d.afterMatch, color: "var(--red-600)" },
                  ]}
                  summary={`${d.beforeMatch} before a driver took it, ${d.afterMatch} after`}
                />
              </Section>
            </div>
            <Section title="By hour of the request">
              <PairedBars
                series={[{ label: "Cancellations", color: "var(--red-600)", values: DAY_HOURS.map((h) => d.byHour[h] ?? 0) }]}
                labels={DAY_HOURS.map((h) => (h === 7 || h === 12 ? hourLabel(h) : hourLabel(h, false)))}
                summary="Cancelled requests by the hour they were made"
                height={160}
              />
            </Section>
            <Section
              title="Cancelled rides"
              actions={
                <label className="field inline">
                  <span>Cancelled by</span>
                  <select value={who} onChange={(e) => setParams({ who: e.target.value || null }, { replace: true })}>
                    {WHO.map((w) => (
                      <option key={w.value} value={w.value}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                </label>
              }
            >
              <DataTable
                columns={rideColumns()}
                rows={d.rides}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(withParams(path, search, { ride: r.id }))}
                rowLabel={(r) => `Open ride by ${r.rider.name}`}
                empty="No cancelled rides."
              />
            </Section>
          </>
        )}
      </Loaded>
    </Page>
  );
}
