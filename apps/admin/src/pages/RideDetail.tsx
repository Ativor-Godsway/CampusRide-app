import { useState } from "react";
import { decodePolyline } from "@rida/shared";
import { ApiError, cancelRideAsAdmin, cancelSeatAsAdmin, getRideDetail, type RideDetail as Detail } from "../api";
import { useToken } from "../auth";
import { Chip } from "../components/Chip";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
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

type Seat = Detail["seats"][number];
type Cancelling = { kind: "ride" } | { kind: "seat"; seat: Seat };

/** How a seat reads, with the leftover of a merged request said plainly. */
function seatLabel(s: Seat): string {
  if (s.movedToCar && (s.status === "WAITING" || s.status === "ARRIVED")) return "Moved to another car";
  if (s.status === "CANCELLED" && s.driverCancel) return "Driver cancelled pickup";
  return SEAT_LABELS[s.status] ?? s.status;
}

/** One ride in full: what happened when, who was offered it, who rode and paid what, the route, ratings, SOS; cancel a seat or the ride. */
export function RideDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const token = useToken();
  const toast = useToast();
  const detail = usePolled(() => getRideDetail(token, id), `ride:${id}`);
  const r = detail.data?.ride;
  const chip = r ? rideStatusChip(r) : null;
  const [cancelling, setCancelling] = useState<Cancelling | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (reason: string) => {
    if (!cancelling) return;
    setBusy(true);
    setError(null);
    try {
      if (cancelling.kind === "ride") {
        await cancelRideAsAdmin(token, id, reason);
        toast("Ride cancelled. The riders and the driver have been told.");
      } else {
        const res = await cancelSeatAsAdmin(token, id, cancelling.seat.id, reason);
        toast(
          res.alsoCancelledOnRideId
            ? `${cancelling.seat.rider.name}'s seat is cancelled here and in the car they joined.`
            : `${cancelling.seat.rider.name}'s seat is cancelled.`,
        );
      }
      setCancelling(null);
      detail.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work");
    } finally {
      setBusy(false);
    }
  };

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

            {d.ride.cancellable ? (
              <div className="button-row">
                <button type="button" className="danger-text-button" onClick={() => setCancelling({ kind: "ride" })}>
                  Cancel whole ride
                </button>
              </div>
            ) : null}

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
                  <th scope="col">
                    <span className="sr-only">Actions</span>
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
                    <td>
                      {seatLabel(s)}
                      {s.driverCancel ? (
                        <span className="muted small">
                          {" "}
                          · {s.driverCancel.driverName}: {s.driverCancel.reasonLabel ?? "no reason given"}
                          {s.driverCancel.note ? ` ("${s.driverCancel.note}")` : ""}
                          {s.driverCancel.rebookedRideId ? (
                            <>
                              {" "}
                              · <Link to={`/rides?ride=${s.driverCancel.rebookedRideId}`}>new search</Link>
                            </>
                          ) : null}
                        </span>
                      ) : null}
                    </td>
                    <td className="right num">{cedis(s.farePesewas)}</td>
                    <td className="right">
                      {s.cancellable ? (
                        <button type="button" className="danger-text-button" onClick={() => setCancelling({ kind: "seat", seat: s })}>
                          Cancel this rider&apos;s seat
                        </button>
                      ) : null}
                    </td>
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
      {cancelling && r ? (
        <ConfirmDialog
          title={cancelling.kind === "ride" ? "Cancel the whole ride?" : `Cancel ${cancelling.seat.rider.name}'s seat?`}
          confirmLabel={cancelling.kind === "ride" ? "Cancel ride" : "Cancel seat"}
          danger
          reasonLabel="Why (saved in the audit log)"
          reasonPlaceholder="e.g. Stuck after the driver's phone died; rider phoned support"
          busy={busy}
          error={error}
          onCancel={() => {
            setCancelling(null);
            setError(null);
          }}
          onConfirm={(reason) => void cancel(reason)}
        >
          {cancelling.kind === "ride" ? (
            <p>
              Every rider not yet dropped off loses their seat and is told CampusRide cancelled it; the driver is told and is free for new requests. If
              someone was already dropped off, the trip is closed as completed so their fare stands. Riders are not booked again.
            </p>
          ) : cancelling.seat.movedToCar ? (
            <p>
              This request was added to another driver&apos;s car. Its seat here is tidied up, and {cancelling.seat.rider.name}&apos;s seat in that car is
              cancelled too. They and the driver are told. They are not booked again.
            </p>
          ) : (
            <p>
              {cancelling.seat.rider.name} is told CampusRide cancelled their seat; the driver is told and the car carries on for anyone else. If nobody is
              left, the trip ends. They are not booked again.
            </p>
          )}
        </ConfirmDialog>
      ) : null}
    </DetailDrawer>
  );
}
