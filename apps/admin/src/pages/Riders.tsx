import { useState } from "react";
import { getRiders } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { PairedBars } from "../charts/PairedBars";
import { count, percent } from "../lib/money";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter, withParams } from "../lib/router";
import { shortDay } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { DeleteAccountScreen } from "../screens/DeleteAccountScreen";
import { RateLimitsScreen } from "../screens/RateLimitsScreen";
import { Freshness, Page, Section } from "../shell/Page";

/** "26" for a day label (with the month on the 1st and the first bar). */
function dayTick(day: string, i: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  return i === 0 || d.getUTCDate() === 1 ? shortDay(d).split(" ").slice(1).join(" ") : String(d.getUTCDate());
}

/**
 * Riders: how many, how many new and active in the period, how many come
 * back, sign-ups per day, and every rider (phones masked; search by phone).
 * A rider opens their detail: rides, ratings, SOS, early access, rate
 * limits and deleting the account. The two tools also work for any number.
 */
export function RidersPage() {
  const token = useToken();
  const { path, search, navigate, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("riders", "this-month");
  const q = search.get("q") ?? "";
  const page = Number(search.get("page") ?? 1) || 1;
  const [term, setTerm] = useState(q);
  const query = periodQuery(period);
  const data = usePolled(() => getRiders(token, query, q, page), `${query}|${q}|${page}`);
  const [tool, setTool] = useState<"limits" | "delete" | null>(null);

  return (
    <Page title="Riders" subtitle={periodLabel(period)} controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} choices={["this-week", "last-week", "this-month", "last-30", "all-time"]} />
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => (
          <>
            <TileRow>
              <StatTile label="Riders" value={count(d.riders)} note="Open accounts" />
              <StatTile label="New this period" value={count(d.newInPeriod)} />
              <StatTile label="Active this period" value={count(d.activeInPeriod)} note="At least one completed ride" />
              <StatTile label="Returning" value={count(d.returning)} note={d.returningRate === null ? "Not enough data yet" : `${percent(d.returningRate)} of riders who have ridden`} />
            </TileRow>
            <Section title="Sign-ups per day">
              <PairedBars
                series={[{ label: "Sign-ups", color: "var(--green-500)", values: d.signupsPerDay.map((s) => s.count) }]}
                labels={d.signupsPerDay.map((s, i) => dayTick(s.day, i))}
                summary={`New rider accounts per day: ${d.newInPeriod} in all.`}
                height={160}
                showEvery={d.signupsPerDay.length > 14 ? 3 : 1}
              />
            </Section>
            <Section
              title={`${count(d.total)} ${q ? "matching" : ""} ${d.total === 1 ? "rider" : "riders"}`}
              actions={
                <form
                  className="inline-search"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setParams({ q: term.trim() || null, page: null }, { replace: true });
                  }}
                >
                  <label className="field inline">
                    <span className="sr-only">Search riders by phone or name</span>
                    <input type="search" value={term} placeholder="Phone or name" onChange={(e) => setTerm(e.target.value)} />
                  </label>
                  <button type="submit" className="tonal-button small">
                    Search
                  </button>
                </form>
              }
            >
              <DataTable
                columns={[
                  { key: "name", header: "Name", render: (r) => <strong>{r.name}</strong>, sortValue: (r) => r.name },
                  { key: "phone", header: "Phone", render: (r) => <span className="num">{r.maskedPhone ?? "—"}</span>, phoneHidden: true },
                  { key: "joined", header: "Joined", render: (r) => <span className="nowrap">{shortDay(r.joinedAt)}</span>, sortValue: (r) => r.joinedAt },
                  { key: "rides", header: "Rides", render: (r) => <span className="num">{r.rides}</span>, sortValue: (r) => r.rides, align: "right" },
                  { key: "last", header: "Last ride", render: (r) => (r.lastRideAt ? shortDay(r.lastRideAt) : <span className="muted">Never</span>), sortValue: (r) => r.lastRideAt, phoneHidden: true },
                  { key: "early", header: "Early access", render: (r) => (r.earlyAccess ? <Chip tone="green">Early access</Chip> : <span className="muted">—</span>), sortValue: (r) => String(r.earlyAccess) },
                ]}
                rows={d.list}
                rowKey={(r) => r.id}
                onRowClick={(r) => navigate(withParams(path, search, { rider: r.id }))}
                rowLabel={(r) => `Open ${r.name}`}
                empty={q ? "No rider matches that." : "No riders yet."}
                paging={{ page, pageSize: d.pageSize, total: d.total, onPage: (p) => setParams({ page: String(p) }) }}
              />
            </Section>
          </>
        )}
      </Loaded>

      <Section title="For any phone number">
        <div className="button-row">
          <button type="button" className={tool === "limits" ? "tonal-button active" : "tonal-button"} aria-expanded={tool === "limits"} onClick={() => setTool(tool === "limits" ? null : "limits")}>
            Can&apos;t log in? Check rate limits
          </button>
          <button type="button" className={tool === "delete" ? "tonal-button active" : "tonal-button"} aria-expanded={tool === "delete"} onClick={() => setTool(tool === "delete" ? null : "delete")}>
            Delete an account (emailed request)
          </button>
        </div>
        {tool === "limits" ? <RateLimitsScreen /> : null}
        {tool === "delete" ? <DeleteAccountScreen /> : null}
      </Section>
    </Page>
  );
}
