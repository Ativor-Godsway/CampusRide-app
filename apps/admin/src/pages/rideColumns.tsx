import type { RideRow } from "../api";
import { Chip } from "../components/Chip";
import type { Column } from "../components/DataTable";
import { cedis } from "../lib/money";
import { rideStatusChip, rideTypeLabel, shortName } from "../lib/labels";
import { whenShort } from "../lib/time";

/** The ride table's columns, the same on every page that lists rides. */
/**
 * `compact`: for a detail panel, without the column the panel is about (a
 * driver's own trips don't need the driver) and without the ride type.
 */
export function rideColumns(opts: { now?: number; withSeats?: boolean; compact?: "driver" | "rider" } = {}): Column<RideRow>[] {
  const cols: Column<RideRow>[] = [
    { key: "time", header: "Time", render: (r) => <span className="num nowrap">{whenShort(r.createdAt, opts.now)}</span>, sortValue: (r) => r.createdAt },
    { key: "rider", header: "Rider", render: (r) => <span className="nowrap">{shortName(r.rider.name)}</span>, sortValue: (r) => r.rider.name },
    { key: "driver", header: "Driver", render: (r) => (r.driver ? <span className="nowrap">{shortName(r.driver.name)}</span> : <span className="muted">—</span>), sortValue: (r) => r.driver?.name ?? null, phoneHidden: true },
    {
      key: "route",
      header: "Route",
      render: (r) => (
        <span>
          {r.pickup} <span aria-label="to">→</span> {r.dropoff}
        </span>
      ),
    },
    { key: "type", header: "Type", render: (r) => rideTypeLabel(r.type), sortValue: (r) => r.type, phoneHidden: true },
  ];
  if (opts.compact) {
    const kept = cols.filter((c) => c.key !== opts.compact && c.key !== "type");
    cols.splice(0, cols.length, ...kept);
  }
  if (opts.withSeats) cols.push({ key: "seats", header: "Seats", render: (r) => <span className="num">{r.seats}</span>, sortValue: (r) => r.seats, align: "right", phoneHidden: true });
  cols.push(
    {
      key: "fare",
      header: "Fare",
      render: (r) => (
        <span className="num">
          {cedis(r.fareTotal)}
          {r.fareTotal !== null && !r.fareFinal ? <span className="muted small"> so far</span> : null}
        </span>
      ),
      sortValue: (r) => r.fareTotal,
      align: "right",
    },
    {
      key: "status",
      header: "Status",
      render: (r) => {
        const chip = rideStatusChip(r);
        return (
          <span className="status-cell">
            <Chip tone={chip.tone}>{chip.label}</Chip>
            {r.riderCancelFlagged ? <Chip tone="amber" title={r.riderCancelReasonLabel ?? undefined}>Check driver</Chip> : null}
          </span>
        );
      },
      sortValue: (r) => r.status,
    },
  );
  return cols;
}
