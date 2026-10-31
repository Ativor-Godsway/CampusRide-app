import { decodePolyline } from "@rida/shared";
import { getRideDetail, type RideDetail as Detail } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { DetailDrawer } from "../components/DetailDrawer";
import { Loaded } from "../components/States";
import { CampusMap } from "../map/CampusMap";
import { RouteLine, StopMarker } from "../map/Markers";
import { cedis } from "../lib/money";
import { OFFER_OUTCOME_LABELS, rideStatusChip, rideTypeLabel } from "../lib/labels";
import { Link } from "../lib/router";
import { clock, dayAndTime, duration } from "../lib/time";
import { usePolled } from "../lib/usePolled";

const SEAT_LABELS: Record<string, string> = {
  WAITING: "Waiting",
  ARRIVED: "Driver arrived",
  PICKED_UP: "In the car",
  DROPPED_OFF: "Dropped off",
  CANCELLED: "Cancelled",
};

function RouteMap({ d }: { d: Detail }) {
  const pickup = d.ride.pickupPin;
  const dropoff = d.ride.dropoffPin;
  const route = d.ride.routePolyline ? decodePolyline(d.ride.routePolyline).map((pt) => ({ latitude: pt.latitude, longitude: pt.longitude })) : null;
  if (!pickup && !dropoff) return <p className="muted small">This ride was booked by an app without exact pins: zones only ({d.ride.pickupZone.name} → {d.ride.dropoffZone.name}).</p>;
  return (
    <CampusMap label={`Route from ${d.ride.pickup} to ${d.ride.dropoff}`} height={280} fit={[...(pickup ? [pickup] : []), ...(dropoff ? [dropoff] : []), ...d.seats.flatMap((s) => [s.pickupPin, s.dropoffPin].filter((x): x is { latitude: number; longitude: number } => x !== null))]}>
      {({ p, k }) => (
        <>
          {route ? <RouteLine p={p} points={route} /> : pickup && dropoff ? <RouteLine p={p} points={[pickup, dropoff]} className="map-route dashed" /> : null}
          {d.seats.map((s) => (
            <g key={s.id}>
              {s.pickupPin ? <StopMarker p={p} k={k} {...s.pickupPin} kind="pickup" label={`${s.rider.name}'s pickup: ${s.pickup}`} /> : null}
              {s.dropoffPin ? <StopMarker p={p} k={k} {...s.dropoffPin} kind="dropoff" label={`${s.rider.name}'s drop-off: ${s.dropoff}`} /> : null}
            </g>
          ))}
          {pickup ? <StopMarker p={p} k={k} {...pickup} kind="pickup" label={`Pickup: ${pickup.label}`} /> : null}
          {dropoff ? <StopMarker p={p} k={k} {...dropoff} kind="dropoff" label={`Drop-off: ${dropoff.label}`} /> : null}
        </>
      )}
    </CampusMap>
  );
}

/** One ride in full: what happened when, who was offered it, who rode and paid what, the route, ratings, SOS. */
export function RideDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const token = useToken();
  const detail = usePolled(() => getRideDetail(token, id), `ride:${id}`);
  const r = detail.data?.ride;
  const chip = r ? rideStatusChip(r) : null;
  return (
    <DetailDrawer title={r ? `${r.pickup} → ${r.dropoff}` : "Ride"} subtitle={r ? `${rideTypeLabel(r.type)} · ${dayAndTime(r.createdAt)} · ride ${r.id.slice(-6)}` : undefined} onClose={onClose}>
      <Loaded {...detail} onRetry={detail.refresh} what="Loading the ride…">
        {(d) => (
          <div className="detail-stack">
            <div className="chip-row">
              {chip ? <Chip tone={chip.tone}>{chip.label}</Chip> : null}
              <Chip>{d.ride.paymentMethod === "CASH" ? "Cash" : "Mobile money"}</Chip>
              {d.ride.fareTotal !== null ? <Chip tone="green">{`${cedis(d.ride.fareTotal)}${d.ride.fareFinal ? "" : " so far"}`}</Chip> : null}
            </div>
            <dl className="facts">
              <div>
                <dt>Rider</dt>
                <dd>
                  <Link to={`/riders?rider=${d.ride.rider.id}`}>{d.ride.rider.name}</Link> <span className="muted">{d.ride.rider.maskedPhone}</span>
                </dd>
              </div>
              <div>
                <dt>Driver</dt>
                <dd>{d.ride.driver ? <Link to={`/drivers?driver=${d.ride.driver.driverId ?? d.ride.driver.id}`}>{d.ride.driver.name}</Link> : <span className="muted">None</span>}</dd>
              </div>
              {d.ride.pickupPin?.note ? (
                <div>
                  <dt>Pickup note</dt>
                  <dd>“{d.ride.pickupPin.note}”</dd>
                </div>
              ) : null}
              {d.ride.mergedIntoRideId ? (
                <div>
                  <dt>Joined</dt>
                  <dd>
                    <Link to={`/rides?ride=${d.ride.mergedIntoRideId}`}>the car it was added to</Link>
                  </dd>
                </div>
              ) : null}
            </dl>

            <h3>What happened</h3>
            <ol className="timeline">
              {d.timeline.map((t, i) => (
                <li key={i} className={`tl-${t.kind}`}>
                  <span className="num muted">{clock(t.at)}</span>
                  <span>{t.text}</span>
                </li>
              ))}
            </ol>

            <h3>Riders and fares</h3>
            <table className="mini-table">
              <thead>
                <tr>
                  <th scope="col">Rider</th>
                  <th scope="col">Trip</th>
                  <th scope="col">Seat</th>
                  <th scope="col" className="right">
                    Fare
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.seats.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/riders?rider=${s.rider.id}`}>{s.rider.name}</Link>
                    </td>
                    <td>
                      {s.pickup} → {s.dropoff}
                    </td>
                    <td>{SEAT_LABELS[s.status] ?? s.status}</td>
                    <td className="right num">{cedis(s.farePesewas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.mergedRides.length ? <p className="muted small">Riders added to this car: {d.mergedRides.map((m) => m.riderName).join(", ")}.</p> : null}

            <h3>Route</h3>
            <RouteMap d={d} />

            {d.offers.length ? (
              <>
                <h3>Offers</h3>
                <ul className="plain-list">
                  {d.offers.map((o, i) => (
                    <li key={i}>
                      <strong>{o.driver.name}</strong> · {o.outcome ? OFFER_OUTCOME_LABELS[o.outcome] : "No answer yet"}
                      {o.responseMs !== null && (o.outcome === "ACCEPTED" || o.outcome === "DECLINED") ? <span className="muted"> in {duration(o.responseMs)}</span> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {d.ratings.length ? (
              <>
                <h3>Ratings</h3>
                <ul className="plain-list">
                  {d.ratings.map((rt, i) => (
                    <li key={i}>
                      <span className="stars" aria-label={`${rt.stars} out of 5 stars`}>
                        {"\u2605".repeat(rt.stars)}
                        <span className="stars-off">{"\u2605".repeat(5 - rt.stars)}</span>
                      </span>{" "}
                      {rt.rater.name} rated {rt.ratee.name}
                      {rt.comment ? <> <q className="muted">{rt.comment}</q></> : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {d.sos.length ? (
              <>
                <h3>SOS</h3>
                <ul className="plain-list">
                  {d.sos.map((s) => (
                    <li key={s.id}>
                      <Chip tone={s.handledAt ? "neutral" : "red"}>{s.handledAt ? "Handled" : "Open"}</Chip> {dayAndTime(s.createdAt)} · contact {s.smsDelivered ? "texted" : "not texted"} · support {s.supportNotified ? "texted" : "not texted"}{" "}
                      <Link to="/safety">Safety</Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {d.trackingLinks.length ? (
              <>
                <h3>Tracking links</h3>
                <ul className="plain-list">
                  {d.trackingLinks.map((l, i) => (
                    <li key={i}>
                      {l.riderName}&apos;s link, made {dayAndTime(l.createdAt)} · <Chip tone={l.active ? "green" : "neutral"}>{l.active ? "Still works" : "Expired"}</Chip>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}
      </Loaded>
    </DetailDrawer>
  );
}
