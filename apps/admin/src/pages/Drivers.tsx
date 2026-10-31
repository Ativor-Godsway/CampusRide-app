import { getDrivers, type DriverRow } from "../api";
import { useToken } from "../auth";
import { Chip, type ChipTone } from "../components/Chip";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { cedis, percent } from "../lib/money";
import { initials } from "../lib/labels";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter, withParams } from "../lib/router";
import { duration, hours } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { DriverQueue } from "../screens/DriverQueue";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

type Tab = "all" | "online" | "approval" | "suspended";

/** What a driver is doing now, as a chip. */
export function driverNow(d: Pick<DriverRow, "isApproved" | "suspended" | "isOnline" | "onTrip">): { label: string; tone: ChipTone } {
  if (d.suspended) return { label: "Suspended", tone: "red" };
  if (!d.isApproved) return { label: "Needs approval", tone: "amber" };
  if (d.onTrip) return { label: "On trip", tone: "dark" };
  if (d.isOnline) return { label: "Online", tone: "green" };
  return { label: "Offline", tone: "neutral" };
}

function DriverCell({ d }: { d: DriverRow }) {
  return (
    <span className="person-cell">
      {d.photoUrl ? <img className="avatar-img" src={d.photoUrl} alt="" loading="lazy" /> : <span className="avatar light" aria-hidden="true">{initials(d.name)}</span>}
      <span>
        <strong>{d.name}</strong>
        <span className="muted small block">{d.plate ?? "No plate yet"}</span>
      </span>
    </span>
  );
}

/**
 * Drivers: everyone who drives (or wants to), with the period's trips,
 * hours online, earnings, acceptance and rating. "Needs approval" holds the
 * approval queue, unchanged. Each driver opens their detail (earnings,
 * sessions, offers, location trail, suspend).
 */
export function DriversPage() {
  const token = useToken();
  const { path, search, navigate, setParams } = useRouter();
  const { refreshSummary } = useShell();
  const [period, setPeriod] = usePagePeriod("drivers", "this-week");
  const tab = (search.get("tab") as Tab | null) ?? "all";
  const query = periodQuery(period);
  const list = usePolled(() => getDrivers(token, query), query);
  const counts = list.data?.counts;

  const rows = (list.data?.drivers ?? []).filter((d) =>
    tab === "online" ? d.isOnline : tab === "approval" ? !d.isApproved && !d.suspended : tab === "suspended" ? d.suspended : true,
  );
  const tabs: Array<{ value: Tab; label: string; n?: number }> = [
    { value: "all", label: "All", n: counts?.all },
    { value: "online", label: "Online", n: counts?.online },
    { value: "approval", label: "Needs approval", n: counts?.needsApproval },
    { value: "suspended", label: "Suspended", n: counts?.suspended },
  ];

  return (
    <Page title="Drivers" subtitle={periodLabel(period)} controls={<Freshness updatedAt={list.updatedAt} onRefresh={list.refresh} loading={list.loading} />}>
      <div className="toolbar">
        <div className="segmented" role="tablist" aria-label="Which drivers">
          {tabs.map((t) => (
            <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} className={tab === t.value ? "seg active" : "seg"} onClick={() => setParams({ tab: t.value === "all" ? null : t.value }, { replace: true })}>
              {t.label}
              {t.n !== undefined ? <span className="num seg-count">{t.n}</span> : null}
            </button>
          ))}
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {tab === "approval" ? (
        <Section title="Waiting for approval">
          <DriverQueue
            onChange={() => {
              list.refresh();
              refreshSummary();
            }}
          />
        </Section>
      ) : (
        <Section>
          <DataTable
            columns={[
              { key: "driver", header: "Driver", render: (d) => <DriverCell d={d} />, sortValue: (d) => d.name },
              {
                key: "now",
                header: "Now",
                render: (d) => {
                  const n = driverNow(d);
                  return <Chip tone={n.tone}>{n.label}</Chip>;
                },
                sortValue: (d) => driverNow(d).label,
              },
              { key: "trips", header: "Trips", render: (d) => <span className="num">{d.trips}</span>, sortValue: (d) => d.trips, align: "right" },
              { key: "online", header: "Online", render: (d) => <span className="num">{hours(d.hoursOnlineMs)}</span>, sortValue: (d) => d.hoursOnlineMs, align: "right" },
              { key: "earned", header: "Earned", render: (d) => <span className="num">{d.trips ? cedis(d.earnedPesewas) : "—"}</span>, sortValue: (d) => d.earnedPesewas, align: "right" },
              {
                key: "accepted",
                header: "Accepted",
                render: (d) => (
                  <span className="num" title={d.acceptanceRate === null ? "Not enough data yet" : `${d.offers} offers`}>
                    {percent(d.acceptanceRate)}
                  </span>
                ),
                sortValue: (d) => d.acceptanceRate,
                align: "right",
                phoneHidden: true,
              },
              { key: "reply", header: "Avg reply", render: (d) => <span className="num">{duration(d.avgReplyMs)}</span>, sortValue: (d) => d.avgReplyMs, align: "right", phoneHidden: true },
              {
                key: "rating",
                header: "Rating",
                render: (d) => (
                  <span className="num" title={d.rating === null ? "Not enough data yet" : `${d.ratings} ratings`}>
                    {d.rating === null ? "—" : d.rating.toFixed(1)}
                  </span>
                ),
                sortValue: (d) => d.rating,
                align: "right",
              },
            ]}
            rows={list.data ? rows : null}
            loading={list.loading}
            error={list.error}
            onRetry={list.refresh}
            rowKey={(d) => d.driverId}
            onRowClick={(d) => navigate(withParams(path, search, { driver: d.driverId }))}
            rowLabel={(d) => `Open ${d.name}`}
            empty={tab === "online" ? "No drivers are online right now." : tab === "suspended" ? "No driver is suspended." : "No drivers yet."}
            initialSort={{ key: "trips", dir: "desc" }}
          />
          <p className="muted small">Earned is the driver&apos;s 85% of the fares of trips completed in the period. Accepted counts accepted ÷ (accepted + declined + timed out).</p>
        </Section>
      )}
    </Page>
  );
}
