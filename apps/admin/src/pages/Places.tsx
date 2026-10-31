import { getPlacesActivity } from "../api";
import { useToken } from "../auth";
import { DataTable } from "../components/DataTable";
import { PeriodPicker } from "../components/PeriodPicker";
import { Loaded } from "../components/States";
import { CampusMap } from "../map/CampusMap";
import { heatRadius } from "../charts/math";
import { periodLabel, periodQuery } from "../lib/period";
import { useRouter } from "../lib/router";
import { usePagePeriod } from "../lib/usePeriod";
import { usePolled } from "../lib/usePolled";
import { PlacesScreen } from "../screens/PlacesScreen";
import { Freshness, Page, Section } from "../shell/Page";

/**
 * Places: where rides start and end (heat map and the busiest places, with
 * how often nobody got a driver there), then the place editor, unchanged.
 */
export function PlacesPage() {
  const token = useToken();
  const { search, setParams } = useRouter();
  const [period, setPeriod] = usePagePeriod("places", "this-month");
  const showDropoffs = search.get("show") === "dropoffs";
  const query = periodQuery(period);
  const data = usePolled(() => getPlacesActivity(token, query), query);

  return (
    <Page title="Places" subtitle="Where rides start and end, and the campus place list" controls={<Freshness updatedAt={data.updatedAt} onRefresh={data.refresh} loading={data.loading} />}>
      <div className="toolbar">
        <PeriodPicker value={period} onChange={setPeriod} choices={["this-week", "last-week", "this-month", "last-30", "all-time"]} />
        <span className="muted">{periodLabel(period)}</span>
      </div>
      <Loaded {...data} onRetry={data.refresh}>
        {(d) => {
          const cells = showDropoffs ? d.dropoffs : d.pickups;
          const max = Math.max(0, ...cells.map((c) => c.count));
          return (
            <div className="grid-2">
              <Section
                title={showDropoffs ? "Drop-offs" : "Pickups"}
                actions={
                  <div className="segmented small" role="group" aria-label="Show">
                    <button type="button" className={showDropoffs ? "seg" : "seg active"} aria-pressed={!showDropoffs} onClick={() => setParams({ show: null }, { replace: true })}>
                      Pickups
                    </button>
                    <button type="button" className={showDropoffs ? "seg active" : "seg"} aria-pressed={showDropoffs} onClick={() => setParams({ show: "dropoffs" }, { replace: true })}>
                      Drop-offs
                    </button>
                  </div>
                }
              >
                <CampusMap label={`${showDropoffs ? "Drop-offs" : "Pickups"} on campus: ${cells.reduce((s, c) => s + c.count, 0)} in this period`} height={420}>
                  {({ p, k }) =>
                    cells.map((c) => {
                      const [x, y] = p.project(c.latitude, c.longitude);
                      return (
                        <circle key={`${c.latitude}:${c.longitude}`} cx={x} cy={y} r={heatRadius(c.count, max) / k} className={showDropoffs ? "heat-dot dropoff" : "heat-dot"}>
                          <title>{`${c.count} ${showDropoffs ? "drop-offs" : "pickups"} here`}</title>
                        </circle>
                      );
                    })
                  }
                </CampusMap>
                <p className="muted small">Bigger, darker circles: more rides. Rides booked by app versions without exact pins aren&apos;t on the map.</p>
              </Section>
              <Section title="Top places">
                <DataTable
                  columns={[
                    { key: "name", header: "Place", render: (pl) => pl.name, sortValue: (pl) => pl.name },
                    { key: "pickups", header: "Pickups", render: (pl) => <span className="num">{pl.pickups}</span>, sortValue: (pl) => pl.pickups, align: "right" },
                    { key: "dropoffs", header: "Drop-offs", render: (pl) => <span className="num">{pl.dropoffs}</span>, sortValue: (pl) => pl.dropoffs, align: "right" },
                    { key: "nodriver", header: "No driver", render: (pl) => <span className="num">{pl.noDriver}</span>, sortValue: (pl) => pl.noDriver, align: "right" },
                  ]}
                  rows={d.places}
                  rowKey={(pl) => pl.name}
                  empty="No rides in this period."
                  pageSize={10}
                />
              </Section>
            </div>
          );
        }}
      </Loaded>
      <Section title="Edit places">
        <PlacesScreen />
      </Section>
    </Page>
  );
}
