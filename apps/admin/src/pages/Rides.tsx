import { useEffect, useState } from "react";
import { getDrivers, getRidePage, getZones, type RideRow } from "../api";
import { useToken } from "../auth";
import { CsvButton } from "../components/CsvButton";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { RIDE_STATUS_FILTERS, rideStatusChip, rideTypeLabel } from "../lib/labels";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter, withParams } from "../lib/router";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";
import { rideColumns } from "./rideColumns";

const PAGE_SIZE = 50;
/** The CSV: up to this many rides of the period (the server allows 92 days). */
const EXPORT_ROWS = 5000;

/** CSV columns for a ride (money in cedis, two decimals; times ISO, Accra = UTC). */
export function rideCsvRow(r: RideRow): Array<string | number | null> {
  return [
    r.id,
    r.createdAt,
    r.completedAt,
    rideTypeLabel(r.type),
    r.seats,
    r.rider.name,
    r.driver?.name ?? null,
    r.pickup,
    r.dropoff,
    r.fareTotal === null ? null : (r.fareTotal / 100).toFixed(2),
    rideStatusChip(r).label,
    r.riderCancelReasonLabel,
  ];
}

export const RIDE_CSV_HEADER = ["Ride ID", "Requested (UTC)", "Completed (UTC)", "Type", "Seats", "Rider", "Driver", "Pickup", "Drop-off", "Fare (GHS)", "Status", "Rider's cancel reason"];

/** Rides: every ride of a period, filtered and searched, a page at a time; each opens its full detail. */
export function RidesPage() {
  const token = useToken();
  const { path, search, navigate, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("rides", "today");
  const filters = {
    status: search.get("status") ?? "",
    type: search.get("type") ?? "",
    zoneId: search.get("zone") ?? "",
    driverId: search.get("driverId") ?? "",
    riderPhone: search.get("phone") ?? "",
    q: search.get("q") ?? "",
  };
  const page = Number(search.get("page") ?? 1) || 1;
  const query = periodQuery(period);
  const key = `${query}|${JSON.stringify(filters)}|${page}`;
  const rides = usePolled(() => getRidePage(token, { period: query, ...filters, page, pageSize: PAGE_SIZE }), key);

  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);
  const [drivers, setDrivers] = useState<Array<{ userId: string; name: string }>>([]);
  useEffect(() => {
    getZones(token).then((z) => setZones(z.zones), () => undefined);
    getDrivers(token, query).then((d) => setDrivers(d.drivers.filter((x) => x.isApproved).map((x) => ({ userId: x.userId, name: x.name }))), () => undefined);
  }, [token, query]);

  const [phone, setPhone] = useState(filters.riderPhone);
  const [rideId, setRideId] = useState(filters.q);
  const set = (k: string, v: string) => setParams({ [k]: v || null, page: null }, { replace: true });

  return (
    <Page
      title="Rides"
      subtitle={periodLabel(period)}
      controls={<Freshness updatedAt={rides.updatedAt} onRefresh={rides.refresh} loading={rides.loading} />}
    >
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ phone: phone.trim() || null, q: rideId.trim() || null, page: null }, { replace: true });
        }}
      >
        <label className="field">
          <span>Status</span>
          <select value={filters.status} onChange={(e) => set("status", e.target.value)}>
            {RIDE_STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={filters.type} onChange={(e) => set("type", e.target.value)}>
            <option value="">Shared and alone</option>
            <option value="SHARED">Shared</option>
            <option value="LONE">Alone</option>
          </select>
        </label>
        <label className="field">
          <span>Pickup zone</span>
          <select value={filters.zoneId} onChange={(e) => set("zone", e.target.value)}>
            <option value="">Any zone</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Driver</span>
          <select value={filters.driverId} onChange={(e) => set("driverId", e.target.value)}>
            <option value="">Any driver</option>
            {drivers.map((d) => (
              <option key={d.userId} value={d.userId}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Rider phone</span>
          <input type="tel" value={phone} placeholder="0XXXXXXXXX" onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="field">
          <span>Ride ID</span>
          <input value={rideId} placeholder="Start of the ID" onChange={(e) => setRideId(e.target.value)} />
        </label>
        <button type="submit" className="tonal-button">
          Search
        </button>
      </form>

      <Section
        title={rides.data ? `${rides.data.total} ${rides.data.total === 1 ? "ride" : "rides"}` : "Rides"}
        actions={
          <CsvButton
            filename={`campusride-rides-${period.from.toISOString().slice(0, 10)}.csv`}
            header={RIDE_CSV_HEADER}
            rows={async () => (await getRidePage(token, { period: query, ...filters, page: 1, pageSize: EXPORT_ROWS })).rides.map(rideCsvRow)}
          />
        }
      >
        <DataTable
          columns={rideColumns({ withSeats: true })}
          rows={rides.data?.rides ?? null}
          loading={rides.loading}
          error={rides.error}
          onRetry={rides.refresh}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(withParams(path, search, { ride: r.id }))}
          rowLabel={(r) => `Open ride by ${r.rider.name}`}
          empty="No rides match these filters."
          paging={rides.data ? { page, pageSize: PAGE_SIZE, total: rides.data.total, onPage: (p) => setParams({ page: String(p) }) } : undefined}
        />
      </Section>
    </Page>
  );
}
