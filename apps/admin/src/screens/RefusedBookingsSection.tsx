import { getRefusedBookings } from "../api";
import { useToken } from "../auth";
import { DataTable } from "../components/DataTable";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { count } from "../lib/money";
import { usePolled } from "../lib/usePolled";
import { Section } from "../shell/Page";

/** "Mon 23 Nov" for an Accra day (YYYY-MM-DD). */
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Refused bookings: demand that never became a ride (server: services/ride/
 * refusedBookings.ts). Anonymous — no rider, phone or pin, just when, where
 * (place and zone) and why. "Tapped Request": the server refused it.
 * "Saw it blocked": the rider opened Choose a ride while CampusRide was
 * closed or had no driver online, so the app showed Request disabled
 * (counted once per rider and trip per half hour).
 */
export function RefusedBookingsSection({ query }: { query: string }) {
  const token = useToken();
  const data = usePolled(() => getRefusedBookings(token, query), `refused|${query}`);
  return (
    <Section title="Refused bookings">
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => {
          const reasons = d.byReason.map((r) => r.reason);
          const label = (r: string) => d.labels[r] ?? r;
          const days = d.days.filter((x) => x.total > 0).reverse();
          return (
            <>
              <TileRow>
                <StatTile label="Refused in this period" value={count(d.total)} />
                {d.byReason.slice(0, 3).map((r) => (
                  <StatTile key={r.reason} label={label(r.reason)} value={count(r.total)} />
                ))}
              </TileRow>
              <DataTable
                columns={[
                  { key: "reason", header: "Reason", render: (r) => label(r.reason), sortValue: (r) => label(r.reason) },
                  { key: "total", header: "Total", render: (r) => <span className="num">{r.total}</span>, sortValue: (r) => r.total, align: "right" },
                  { key: "requests", header: "Tapped Request", render: (r) => <span className="num">{r.requests}</span>, sortValue: (r) => r.requests, align: "right" },
                  { key: "quotes", header: "Saw it blocked", render: (r) => <span className="num">{r.quotes}</span>, sortValue: (r) => r.quotes, align: "right" },
                ]}
                rows={d.byReason}
                rowKey={(r) => r.reason}
                empty="No refused bookings in this period."
              />
              {days.length > 0 ? (
                <DataTable
                  columns={[
                    { key: "day", header: "Day", render: (x) => <span className="nowrap">{dayLabel(x.day)}</span>, sortValue: (x) => x.day },
                    ...reasons.map((r) => ({
                      key: r,
                      header: label(r),
                      render: (x: (typeof days)[number]) => <span className="num">{x.byReason[r] ?? 0}</span>,
                      sortValue: (x: (typeof days)[number]) => x.byReason[r] ?? 0,
                      align: "right" as const,
                    })),
                    { key: "total", header: "Total", render: (x) => <strong className="num">{x.total}</strong>, sortValue: (x) => x.total, align: "right" },
                  ]}
                  rows={days}
                  rowKey={(x) => x.day}
                  pageSize={14}
                />
              ) : null}
              {d.topPickupZones.length > 0 ? (
                <p className="muted small">
                  Most refused pickup zones: {d.topPickupZones.map((z) => `${z.name ?? "off campus or unknown"} (${z.total})`).join(", ")}.
                </p>
              ) : null}
              <p className="muted small">
                Anonymous: no rider, phone or exact pin is kept. &ldquo;Tapped Request&rdquo;: the server refused the booking. &ldquo;Saw it blocked&rdquo;: the rider
                opened Choose a ride while booking was closed, so the app showed Request disabled (counted once per rider and trip per half hour). Recorded from
                24 Nov 2026.
              </p>
            </>
          );
        }}
      </Loaded>
    </Section>
  );
}
