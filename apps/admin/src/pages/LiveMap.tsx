import { useEffect, useMemo, useState } from "react";
import { getLive, getPlaces, type AdminPlace, type Live, type LiveDriver, type LiveRequest } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { Loaded } from "../components/States";
import { CampusMap } from "../map/CampusMap";
import { CarMarker, RouteLine, StopMarker, WaitingMarker } from "../map/Markers";
import { initials, shortName } from "../lib/labels";
import { useRouter, withParams } from "../lib/router";
import { ago, duration } from "../lib/time";
import { LIVE_REFRESH_MS, useNow, usePolled } from "../lib/usePolled";
import { Freshness, Page } from "../shell/Page";

type Filter = "all" | "waiting" | "on-trip" | "requests";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "on-trip", label: "On trip" },
  { value: "requests", label: "Requests" },
];

/** "Offered to 2 drivers, both declined", "Not offered to anyone yet". */
export function offerLine(r: Pick<LiveRequest, "offeredTo" | "declined" | "timedOut">): string {
  if (r.offeredTo === 0) return "No driver near enough to offer it to yet";
  const said: string[] = [];
  if (r.declined) said.push(`${r.declined} declined`);
  if (r.timedOut) said.push(`${r.timedOut} didn't answer`);
  const all = r.declined + r.timedOut === r.offeredTo;
  const answered = all && r.offeredTo === 2 && r.declined === 2 ? "both declined" : said.join(", ");
  return `Offered to ${r.offeredTo} ${r.offeredTo === 1 ? "driver" : "drivers"}${answered ? `, ${answered}` : ""}`;
}

function driverStatus(d: LiveDriver, live: Live): { label: string; tone: "green" | "dark" } {
  if (d.status === "ON_TRIP") {
    const trip = live.trips.find((t) => t.driverUserId === d.userId);
    return { label: `On trip${trip ? ` · ${trip.riders} ${trip.riders === 1 ? "rider" : "riders"}` : ""}`, tone: "dark" };
  }
  return { label: "Waiting", tone: "green" };
}

/**
 * Live map: every online driver (green waiting, dark on a trip, pointing
 * where they're heading), riders waiting for a driver (amber pulse) and the
 * trips under way, on our own campus map. Exact positions (admins only).
 * Asks every 5 s while the tab is visible — from the server's memory, so the
 * database isn't touched.
 */
export function LiveMapPage() {
  const token = useToken();
  const { path, search, navigate, setParams } = useRouter();
  const filter = (search.get("show") as Filter | null) ?? "all";
  const live = usePolled(() => getLive(token), "live", LIVE_REFRESH_MS);
  const now = useNow(1000);
  const [places, setPlaces] = useState<AdminPlace[]>([]);
  useEffect(() => {
    getPlaces(token).then((r) => setPlaces(r.places.filter((p) => p.isActive)), () => undefined);
  }, [token]);
  const mapPlaces = useMemo(() => places.map((p) => ({ name: p.name, latitude: p.latitude, longitude: p.longitude })), [places]);

  const open = (key: "driver" | "ride", id: string) => navigate(withParams(path, search, { [key]: id }));

  return (
    <Page
      title="Live map"
      subtitle="Everything happening on campus right now"
      wide
      controls={
        <>
          <div className="segmented" role="group" aria-label="Show on the map">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" className={filter === f.value ? "seg active" : "seg"} aria-pressed={filter === f.value} onClick={() => setParams({ show: f.value === "all" ? null : f.value }, { replace: true })}>
                {f.label}
              </button>
            ))}
          </div>
          <Freshness updatedAt={live.updatedAt} onRefresh={live.refresh} loading={live.loading} />
        </>
      }
    >
      <Loaded {...live} onRetry={live.refresh} what="Finding drivers…">
        {(data) => {
          const showDrivers = filter !== "requests";
          const showRequests = filter === "all" || filter === "requests";
          const drivers = data.drivers.filter((d) => filter === "all" || filter === "requests" || (filter === "waiting" ? d.status === "WAITING" : d.status === "ON_TRIP"));
          return (
            <div className="live-layout">
              <div className="live-map">
                <CampusMap label={`Campus map: ${data.counts.online} drivers online, ${data.counts.onTrip} on a trip, ${data.counts.ridersWaiting} riders waiting`} height="100%" places={mapPlaces}>
                  {({ p, k }) => (
                    <>
                      {filter !== "waiting" && filter !== "requests"
                        ? data.trips.map((t) => {
                            const car = data.drivers.find((d) => d.userId === t.driverUserId)?.position;
                            const ahead = t.stops.filter((s) => !s.done);
                            return (
                              <g key={t.rideId}>
                                <RouteLine p={p} points={[...(car ? [car] : []), ...ahead]} />
                                {ahead.map((s, i) => (
                                  <StopMarker key={i} p={p} k={k} latitude={s.latitude} longitude={s.longitude} kind={s.kind} label={`${s.kind === "pickup" ? "Pickup" : "Drop-off"}: ${s.label}`} />
                                ))}
                              </g>
                            );
                          })
                        : null}
                      {showRequests
                        ? data.requests.map((r) =>
                            r.pickup ? (
                              <WaitingMarker key={r.rideId} p={p} k={k} latitude={r.pickup.latitude} longitude={r.pickup.longitude} label={`${r.riderName} waiting at ${r.pickupLabel} for ${duration(now - Date.parse(r.requestedAt))}`} onClick={() => open("ride", r.rideId)} />
                            ) : null,
                          )
                        : null}
                      {showDrivers
                        ? drivers.map((d) =>
                            d.position ? (
                              <CarMarker
                                key={d.userId}
                                p={p}
                                k={k}
                                latitude={d.position.latitude}
                                longitude={d.position.longitude}
                                heading={d.position.heading}
                                onTrip={d.status === "ON_TRIP"}
                                stale={!d.position.live}
                                label={`${d.name}, ${d.status === "ON_TRIP" ? "on a trip" : "waiting"}${d.position.live ? "" : " (last known position)"}`}
                                onClick={() => open("driver", d.driverId)}
                              />
                            ) : null,
                          )
                        : null}
                    </>
                  )}
                </CampusMap>
                <div className="map-legend" aria-hidden="true">
                  <span>
                    <span className="key key-green" /> Waiting
                  </span>
                  <span>
                    <span className="key key-dark" /> On trip
                  </span>
                  <span>
                    <span className="key key-amber" /> Rider waiting
                  </span>
                  <span>
                    <span className="key key-dashed" /> Service area
                  </span>
                </div>
              </div>

              <aside className="live-side" aria-label="Who is where">
                <div className="chip-row">
                  <Chip tone="green">{data.counts.online} online</Chip>
                  <Chip tone="dark">{data.counts.onTrip} on trip</Chip>
                  <Chip tone="amber">{data.counts.ridersWaiting} waiting</Chip>
                </div>

                {data.requests.length > 0 ? (
                  <ul className="request-list">
                    {data.requests.map((r) => (
                      <li key={r.rideId}>
                        <button type="button" className="request-card" onClick={() => open("ride", r.rideId)}>
                          <span className="eyebrow">Waiting for a driver · {duration(now - Date.parse(r.requestedAt))}</span>
                          <strong>
                            {shortName(r.riderName)} · {r.pickupLabel} → {r.dropoffLabel}
                          </strong>
                          <span>{offerLine(r)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Nobody is waiting for a driver.</p>
                )}

                <h2 className="side-title">Drivers</h2>
                {data.drivers.length === 0 ? (
                  <p className="muted">No drivers are online.</p>
                ) : (
                  <ul className="driver-list">
                    {data.drivers.map((d) => {
                      const st = driverStatus(d, data);
                      return (
                        <li key={d.userId}>
                          <button type="button" className="driver-row" onClick={() => open("driver", d.driverId)}>
                            <span className="avatar light" aria-hidden="true">
                              {initials(d.name)}
                            </span>
                            <span className="driver-row-text">
                              <strong>{shortName(d.name)}</strong>
                              <span className="muted small">
                                {d.seenAt ? `Seen ${ago(d.seenAt, now)}` : "Not heard from since the server restarted"}
                                {d.app?.state === "background" ? " · app in background" : ""}
                                {d.position && !d.position.live ? " · position not live" : ""}
                              </span>
                            </span>
                            <Chip tone={st.tone}>{st.label}</Chip>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
                <p className="muted small">Updates every 5 seconds while this tab is open. Names and trips refresh once a minute. Driver trails are kept 90 days.</p>
              </aside>
            </div>
          );
        }}
      </Loaded>
    </Page>
  );
}
