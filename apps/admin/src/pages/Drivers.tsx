import { getDrivers, type DriverRow } from "../api";
import { useToken } from "../auth";
import { Chip, type ChipTone } from "../components/Chip";
import { CsvButton } from "../components/CsvButton";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { cedis } from "../lib/money";
import { initials } from "../lib/labels";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter, withParams } from "../lib/router";
import { hours } from "../lib/time";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { DriverQueue } from "../screens/DriverQueue";
import { Freshness, Page, Section } from "../shell/Page";
import { useShell } from "../shell/ShellContext";

type Tab = "all" | "online" | "approval" | "suspended";

/** The ranges the earnings views offer: Today, Yesterday, This week, All time (and Custom). */
export const EARNINGS_RANGES = ["today", "yesterday", "this-week", "all-time"] as const;

const money = (p: number | undefined | null) => (p ? cedis(p) : "—");

/** "GH₵2.10", or "GH₵0 · GH₵1.05 waived". */
export function CommissionCell({ charged, waived }: { charged: number; waived: number }) {
  if (!charged && !waived) return <span className="num">—</span>;
  return (
    <span className="num">
      {cedis(charged)}
      {waived ? <span className="muted small block">{cedis(waived)} waived</span> : null}
    </span>
  );
}

/** The "All drivers" row: the sums of the shown drivers. */
export function driverTotals(rows: DriverRow[]): Record<string, React.ReactNode> {
  const sum = (f: (d: DriverRow) => number) => rows.reduce((t, d) => t + f(d), 0);
  const fares = sum((d) => d.faresPesewas ?? 0);
  const online = sum((d) => d.hoursOnlineMs);
  return {
    driver: `All drivers (${rows.length})`,
    trips: <span className="num">{sum((d) => d.trips)}</span>,
    riders: <span className="num">{sum((d) => d.riders ?? 0)}</span>,
    online: <span className="num">{hours(online)}</span>,
    fares: <span className="num">{cedis(fares)}</span>,
    commission: <CommissionCell charged={sum((d) => d.commissionDuePesewas ?? 0)} waived={sum((d) => d.commissionWaivedPesewas ?? 0)} />,
    topups: <span className="num">{cedis(sum((d) => d.topUpsPesewas ?? 0))}</span>,
    income: <span className="num">{cedis(sum((d) => d.incomePesewas ?? 0))}</span>,
    perHour: <span className="num">{online >= 30 * 60_000 ? cedis(Math.round(fares / (online / 3_600_000))) : "—"}</span>,
  };
}

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
        <PeriodPicker value={period} onChange={setPeriod} choices={EARNINGS_RANGES} />
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
        <Section
          actions={
            <CsvButton
              filename={`drivers-${period.from.toISOString().slice(0, 10)}.csv`}
              header={["Driver", "Plate", "Status", "Trips", "Riders", "Online hours", "Fares GHS", "Commission charged GHS", "Commission waived GHS", "Top-ups GHS", "Total income GHS", "Fares per online hour GHS"]}
              rows={() =>
                rows.map((d) => [
                  d.name,
                  d.plate ?? "",
                  driverNow(d).label,
                  d.trips,
                  d.riders ?? "",
                  Math.round(d.hoursOnlineMs / 360_000) / 10,
                  (d.faresPesewas ?? 0) / 100,
                  (d.commissionDuePesewas ?? 0) / 100,
                  (d.commissionWaivedPesewas ?? 0) / 100,
                  (d.topUpsPesewas ?? 0) / 100,
                  (d.incomePesewas ?? 0) / 100,
                  d.faresPerOnlineHourPesewas != null ? d.faresPerOnlineHourPesewas / 100 : "",
                ])
              }
            />
          }
        >
          <DataTable
            columns={[
              { key: "driver", header: "Driver", render: (d) => <DriverCell d={d} />, sortValue: (d) => d.name },
              {
                key: "now",
                header: "Status",
                render: (d) => {
                  const n = driverNow(d);
                  return <Chip tone={n.tone}>{n.label}</Chip>;
                },
                sortValue: (d) => driverNow(d).label,
                phoneHidden: true,
              },
              { key: "trips", header: "Trips", render: (d) => <span className="num">{d.trips}</span>, sortValue: (d) => d.trips, align: "right" },
              { key: "riders", header: "Riders", render: (d) => <span className="num">{d.riders ?? "—"}</span>, sortValue: (d) => d.riders ?? 0, align: "right", phoneHidden: true },
              { key: "online", header: "Online", render: (d) => <span className="num">{hours(d.hoursOnlineMs)}</span>, sortValue: (d) => d.hoursOnlineMs, align: "right", phoneHidden: true },
              { key: "fares", header: "Fares", render: (d) => <span className="num">{money(d.faresPesewas)}</span>, sortValue: (d) => d.faresPesewas ?? 0, align: "right" },
              {
                key: "commission",
                header: "Commission",
                render: (d) => <CommissionCell charged={d.commissionDuePesewas ?? 0} waived={d.commissionWaivedPesewas ?? 0} />,
                sortValue: (d) => (d.commissionDuePesewas ?? 0) + (d.commissionWaivedPesewas ?? 0),
                align: "right",
              },
              { key: "topups", header: "Top-ups", render: (d) => <span className="num">{money(d.topUpsPesewas)}</span>, sortValue: (d) => d.topUpsPesewas ?? 0, align: "right" },
              {
                key: "income",
                header: "Total income",
                render: (d) => <strong className="num">{money(d.incomePesewas)}</strong>,
                sortValue: (d) => d.incomePesewas ?? 0,
                align: "right",
              },
              {
                key: "perHour",
                header: "Per online hour",
                render: (d) => <span className="num" title="Fares ÷ hours online">{d.faresPerOnlineHourPesewas != null ? cedis(d.faresPerOnlineHourPesewas) : "—"}</span>,
                sortValue: (d) => d.faresPerOnlineHourPesewas ?? null,
                align: "right",
                phoneHidden: true,
              },
            ]}
            rows={list.data ? rows : null}
            loading={list.loading}
            error={list.error}
            onRetry={list.refresh}
            rowKey={(d) => d.driverId}
            onRowClick={(d) => navigate(withParams(path, search, { driver: d.driverId }))}
            rowLabel={(d) => `Open ${d.name}`}
            searchText={(d) => `${d.name} ${d.plate ?? ""} ${d.car ?? ""}`}
            searchLabel="Search by name or plate"
            empty={tab === "online" ? "No drivers are online right now." : tab === "suspended" ? "No driver is suspended." : "No drivers yet."}
            initialSort={{ key: "income", dir: "desc" }}
            pageSize={50}
            footer={rows.length > 1 ? driverTotals(rows) : undefined}
          />
          <p className="muted small">
            For the range chosen above. Total income = fares − commission charged + top-ups. Commission shows what was charged, and what was waived in grey.
          </p>
        </Section>
      )}
    </Page>
  );
}
