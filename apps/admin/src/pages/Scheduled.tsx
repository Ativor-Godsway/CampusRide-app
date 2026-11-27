import { scheduleClock } from "@rida/shared";
import { getScheduledDay, type ScheduledCarRow, type ScheduledDayBody } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DataTable, type Column } from "../components/DataTable";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { count } from "../lib/money";
import { useRouter, withParams } from "../lib/router";
import { usePolled } from "../lib/usePolled";
import { Freshness, Page, Section } from "../shell/Page";

export const CAR_STATUS_WORDS: Record<ScheduledCarRow["status"], string> = {
  OPEN: "Waiting for a driver",
  ACCEPTED: "Driver confirmed",
  STARTED: "Became a trip",
  LIVE: "Converted to live",
  CANCELLED: "Cancelled",
};

export const LIVE_REASON_WORDS: Record<string, string> = {
  ONE_SEAT: "Only 1 seat booked",
  NO_DRIVER: "No driver in time",
  DRIVER_BUSY: "Driver still on a trip",
  LATE: "Past its time",
};

/** The cars of one day as table rows, one per car, in slot order. */
export function carRows(body: ScheduledDayBody): Array<ScheduledCarRow & { arriveBy: string }> {
  return body.slots.flatMap((s) => s.cars.map((c) => ({ ...c, arriveBy: s.arriveBy })));
}

const COLUMNS: Column<ScheduledCarRow & { arriveBy: string }>[] = [
  { key: "slot", header: "Arrive by", render: (c) => <span className="num">{scheduleClock(c.arriveBy)}</span>, sortValue: (c) => c.arriveBy },
  { key: "seats", header: "Seats", render: (c) => <span className="num">{c.seats} of 4</span>, sortValue: (c) => c.seats, align: "right" },
  { key: "bookings", header: "Bookings", render: (c) => <span className="num">{c.bookings}{c.cancelled ? <span className="muted small"> +{c.cancelled} cancelled</span> : null}</span>, phoneHidden: true },
  {
    key: "status",
    header: "Status",
    render: (c) => (
      <span>
        <Chip tone={c.status === "LIVE" || c.status === "CANCELLED" ? "amber" : c.status === "OPEN" ? "neutral" : "green"}>{CAR_STATUS_WORDS[c.status]}</Chip>
        {c.liveReason ? <span className="muted small"> {LIVE_REASON_WORDS[c.liveReason] ?? c.liveReason}</span> : null}
      </span>
    ),
    sortValue: (c) => c.status,
  },
  { key: "driver", header: "Driver", render: (c) => c.driverName ?? <span className="muted">—</span>, phoneHidden: true },
  { key: "leave", header: "Leave by", render: (c) => (c.leaveBy ? <span className="num">{scheduleClock(c.leaveBy)}</span> : <span className="muted">—</span>), phoneHidden: true },
  { key: "noshow", header: "No-shows", render: (c) => <span className="num">{c.noShows}</span>, align: "right", phoneHidden: true },
];

/** Scheduled rides: one day by slot and car, its totals, and the last 14 days. */
export function ScheduledPage() {
  const token = useToken();
  const { path, search, navigate } = useRouter();
  const day = search.get("day") ?? "";
  const data = usePolled(() => getScheduledDay(token, day || undefined), day, undefined, "Loading scheduled rides");

  return (
    <Page title="Scheduled rides" subtitle={data.data?.day ?? day} controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <label className="field">
          <span>Day</span>
          <input type="date" value={day || data.data?.day || ""} onChange={(e) => navigate(withParams(path, search, { day: e.target.value || null }))} />
        </label>
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => (
          <>
            <TileRow>
              <StatTile label="Bookings" value={count(d.totals.bookings)} note={`${count(d.totals.seats)} seats, ${count(d.totals.cancels)} cancelled`} />
              <StatTile label="Cars" value={count(d.totals.cars)} note={`${count(d.totals.accepted)} accepted by a driver`} />
              <StatTile label="Became trips" value={count(d.totals.started)} />
              <StatTile label="Converted to live" value={count(d.totals.toLive)} note={`${count(d.totals.carsToLive)} cars`} noteTone={d.totals.toLive > 0 ? "warn" : undefined} />
              <StatTile label="No-shows" value={count(d.totals.noShows)} noteTone={d.totals.noShows > 0 ? "bad" : undefined} note={`${count(d.totals.lateCancels)} late cancels`} />
              <StatTile label="Strikes" value={count(d.totals.strikes)} note={`${count(d.totals.blockedRiders)} riders can't schedule now`} />
            </TileRow>
            <Section title="Cars by slot">
              <DataTable
                columns={COLUMNS}
                rows={carRows(d)}
                rowKey={(c) => c.id}
                onRowClick={(c) => (c.rideId ? navigate(withParams(path, search, { ride: c.rideId })) : undefined)}
                rowLabel={(c) => `${scheduleClock(c.arriveBy)} car`}
                empty="No scheduled rides this day."
              />
            </Section>
            <Section title="Last 14 days">
              <DataTable
                columns={[
                  { key: "day", header: "Day", render: (r) => <span className="num">{r.day}</span>, sortValue: (r) => r.day },
                  { key: "b", header: "Bookings", render: (r) => <span className="num">{r.bookings}</span>, align: "right" },
                  { key: "s", header: "Seats", render: (r) => <span className="num">{r.seats}</span>, align: "right" },
                  { key: "c", header: "Cars", render: (r) => <span className="num">{r.cars}</span>, align: "right", phoneHidden: true },
                  { key: "t", header: "Trips", render: (r) => <span className="num">{r.started}</span>, align: "right" },
                  { key: "l", header: "To live", render: (r) => <span className="num">{r.toLive}</span>, align: "right" },
                  { key: "n", header: "No-shows", render: (r) => <span className="num">{r.noShows}</span>, align: "right", phoneHidden: true },
                  { key: "k", header: "Strikes", render: (r) => <span className="num">{r.strikes}</span>, align: "right", phoneHidden: true },
                ]}
                rows={[...d.recent].reverse()}
                rowKey={(r) => r.day}
                onRowClick={(r) => navigate(withParams(path, search, { day: r.day }))}
                rowLabel={(r) => r.day}
              />
            </Section>
          </>
        )}
      </Loaded>
    </Page>
  );
}
