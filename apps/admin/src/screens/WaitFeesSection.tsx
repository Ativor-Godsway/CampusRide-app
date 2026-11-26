import { getWaitFees } from "../api";
import { useToken } from "../auth";
import { DataTable } from "../components/DataTable";
import { StatTile, TileRow } from "../components/StatTile";
import { Loaded } from "../components/States";
import { cedis, count } from "../lib/money";
import { usePolled } from "../lib/usePolled";
import { Section } from "../shell/Page";

/** "Mon 23 Nov" for an Accra day (YYYY-MM-DD). */
function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * Wait fees collected per day (server: services/ride/waitFee.ts): the fees
 * on trips completed that day (riders picked up after their free wait), and
 * the no-shows recorded (no fee). The fees are part of the fares, so the 15%
 * commission already counts them.
 */
export function WaitFeesSection({ query }: { query: string }) {
  const token = useToken();
  const data = usePolled(() => getWaitFees(token, query), `wait-fees|${query}`);
  return (
    <Section title="Wait fees">
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => {
          const days = d.days.filter((x) => x.feesPesewas > 0 || x.noShows > 0).reverse();
          return (
            <>
              <TileRow>
                <StatTile label="Wait fees collected" value={cedis(d.totalPesewas)} />
                <StatTile label="Riders who paid one" value={count(d.lateRiders)} />
                <StatTile label="No-shows (no fee)" value={count(d.noShows)} />
              </TileRow>
              <DataTable
                columns={[
                  { key: "day", header: "Day", render: (x) => <span className="nowrap">{dayLabel(x.day)}</span>, sortValue: (x) => x.day },
                  { key: "fees", header: "Wait fees", render: (x) => <span className="num">{cedis(x.feesPesewas)}</span>, sortValue: (x) => x.feesPesewas, align: "right" },
                  { key: "late", header: "Riders", render: (x) => <span className="num">{x.lateRiders}</span>, sortValue: (x) => x.lateRiders, align: "right" },
                  { key: "noShows", header: "No-shows", render: (x) => <span className="num">{x.noShows}</span>, sortValue: (x) => x.noShows, align: "right" },
                ]}
                rows={days}
                rowKey={(x) => x.day}
                empty="No wait fees or no-shows in this period."
              />
            </>
          );
        }}
      </Loaded>
    </Section>
  );
}
