import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  decodePolyline,
  offerKindLabel,
  offerStopLines,
  pointsKey,
  splitFare,
  spokenCedis,
  type LatLng,
  type Zone,
} from "@rida/shared";
import { StatusChip, getRoadRoute } from "@rida/mobile-shared";
import type { ShownOffer } from "../../lib/offers";
import { RequestTakeover } from "./RequestTakeover";

/**
 * A new ride request, full screen over everything (RequestTakeover, mockup
 * 10): the ride type, "New rider" or the rider's rating, the price, the
 * stops with how far and how long, and Accept with the countdown.
 *
 * Places are drawn at their campus zones: the server sends names and
 * numbers only before Accept, never a pickup's exact pin or the rider's note.
 */
export function OfferTakeover({
  offer,
  waiting,
  car,
  zones,
  accepting,
  error,
  onAccept,
  onDecline,
}: {
  offer: ShownOffer;
  /** How many more requests are lined up behind this one. */
  waiting: number;
  /** Where the driver is, or null. */
  car: LatLng | null;
  zones: readonly Zone[];
  /** Accept tapped, waiting for the server. */
  accepting: boolean;
  /** Accept got no answer, or a refusal: said in the panel, with Try again. */
  error: string | null;
  /** Accept, and Try again. */
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { item } = offer;
  const seats = item.seats ?? 1;
  const from = item.pickupPlaceName ?? item.pickupZoneName;
  const to = item.dropoffPlaceName ?? item.dropoffZoneName;
  const lines = offerStopLines(item);

  const pickup = zones.find((z) => z.id === item.pickupZoneId);
  const dropoff = zones.find((z) => z.id === item.dropoffZoneId);
  const ends = useMemo(
    () =>
      pickup && dropoff
        ? [
            { latitude: pickup.latitude, longitude: pickup.longitude },
            { latitude: dropoff.latitude, longitude: dropoff.longitude },
          ]
        : null,
    [pickup, dropoff],
  );
  // The road between the two (POST /routes/legs, cached); a dashed straight
  // line until it answers or if it can't.
  const { data: road } = useQuery({
    queryKey: ["roadRoute", ends ? pointsKey(ends) : "none"],
    queryFn: () => getRoadRoute(ends!),
    enabled: Boolean(ends),
    staleTime: Infinity,
    retry: 1,
  });

  return (
    <RequestTakeover
      accessibilityLabel={`New ride request. ${offerKindLabel(item.type, seats)}, ${spokenCedis(item.farePesewas)}. From ${from} to ${to}.`}
      car={car}
      pickup={ends ? { ...ends[0]!, label: from } : null}
      dropoff={ends ? { ...ends[1]!, label: to } : null}
      route={road ? decodePolyline(road.polyline) : undefined}
      routeIsRoad={road?.source === "osrm"}
      countdown={{
        deadline: offer.deadline,
        totalMs: offer.deadline - offer.shownAt,
        frozenAt: offer.heldAt,
      }}
      eyebrow="New ride request"
      chips={
        <>
          <StatusChip
            tone="neutral"
            icon={item.type === "SHARED" ? "people-outline" : "person-outline"}
            label={offerKindLabel(item.type, seats)}
          />
          {item.riderRating != null ? (
            <StatusChip
              tone="neutral"
              icon="star"
              label={item.riderRating.toFixed(1)}
              accessibilityLabel={`Rider rated ${item.riderRating.toFixed(1)}`}
            />
          ) : (
            <StatusChip tone="warn" label="New rider" />
          )}
        </>
      }
      farePesewas={item.farePesewas}
      earnPesewas={item.driverSharePesewas ?? splitFare(item.farePesewas).driverShare}
      from={from}
      to={to}
      pickupLine={lines.pickup}
      dropoffLine={lines.dropoff}
      footnote={waiting > 0 ? `+${waiting} more waiting` : null}
      accepting={accepting}
      error={error}
      acceptLabel="Accept"
      onAccept={onAccept}
      onDecline={onDecline}
    />
  );
}
