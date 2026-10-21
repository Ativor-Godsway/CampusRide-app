import { splitFare, type LatLng, type TripZone } from "@rida/shared";
import { StatusChip, type AddRiderPreviewResult, type FillSuggestion } from "@rida/mobile-shared";
import { RequestTakeover, type TakeoverCountdown } from "../offers/RequestTakeover";

/**
 * Adding a rider to a shared trip, in the same full-screen style as a new
 * ride offer (RequestTakeover): the map with the new rider's pickup and
 * drop-off and the route with them slotted in, the fare and what the driver
 * earns, where they join the stops, and the server's detour check as
 * "Fits your route · +2 min". An offer the app made by itself counts down;
 * one the driver opened (Add a rider, See route) doesn't.
 */
export function AddRiderTakeover({
  suggestion,
  preview,
  car,
  zones,
  path,
  countdown,
  sharedFarePesewas,
  freeSeats,
  committing,
  onAdd,
  onDecline,
}: {
  suggestion: FillSuggestion;
  /** The server's preview (route, detour, fare); undefined while it's being checked. */
  preview: AddRiderPreviewResult | undefined;
  car: LatLng | null;
  zones: ReadonlyMap<string, TripZone>;
  /** The proposed route, already trimmed to the driver's position. */
  path: LatLng[];
  countdown: TakeoverCountdown | null;
  /** The fare to show until the preview gives the real one. */
  sharedFarePesewas: number;
  freeSeats: number;
  committing: boolean;
  onAdd: () => void;
  onDecline: () => void;
}) {
  const from = preview?.pickupPlaceName ?? suggestion.pickupPlaceName ?? suggestion.pickupZoneName;
  const to = preview?.dropoffPlaceName ?? suggestion.dropoffPlaceName ?? suggestion.dropoffZoneName;
  const fare = preview?.farePesewas ?? sharedFarePesewas;
  const earn = preview?.driverSharePesewas ?? splitFare(fare).driverShare;

  // The new rider's two stops: where the server slots them in, else their zones.
  const newPickup = preview?.stops.find((s) => s.isNew && s.kind === "PICKUP");
  const newDropoff = preview?.stops.find((s) => s.isNew && s.kind === "DROPOFF");
  const pickupZone = zones.get(suggestion.pickupZoneId);
  const dropoffZone = zones.get(suggestion.dropoffZoneId);
  const pickup = newPickup ?? pickupZone;
  const dropoff = newDropoff ?? dropoffZone;
  const total = preview?.stops.length;
  const stopNumber = (index: number | undefined) =>
    index !== undefined && total ? ` · stop ${index + 1} of ${total}` : "";
  const who = suggestion.riderFirstName ? `${suggestion.riderFirstName}, ` : "";

  return (
    <RequestTakeover
      accessibilityLabel={`Add a rider: ${who}from ${from} to ${to}.${preview ? ` Adds about ${preview.addedMinutes} min.` : ""}`}
      car={car}
      pickup={
        pickup ? { latitude: pickup.latitude, longitude: pickup.longitude, label: from } : null
      }
      dropoff={
        dropoff ? { latitude: dropoff.latitude, longitude: dropoff.longitude, label: to } : null
      }
      route={path.length >= 2 ? path : undefined}
      routeIsRoad={path.length >= 2}
      countdown={countdown}
      eyebrow="Add a rider"
      chips={
        <>
          <StatusChip tone="neutral" icon="people-outline" label="Shared · 1 seat" />
          {preview ? (
            <StatusChip
              tone="neutral"
              icon="git-merge-outline"
              label={`Fits your route · +${preview.addedMinutes} min`}
            />
          ) : (
            <StatusChip tone="neutral" label="Checking the route…" />
          )}
        </>
      }
      farePesewas={fare}
      earnPesewas={earn}
      from={from}
      to={to}
      pickupLine={`Pickup${stopNumber(preview?.pickupIndex)}`}
      dropoffLine={`Drop-off${stopNumber(preview?.dropoffIndex)}`}
      footnote={`${freeSeats} free seat${freeSeats === 1 ? "" : "s"} in your car`}
      accepting={committing}
      error={null}
      acceptLabel="Add"
      acceptDisabled={!preview}
      onAccept={onAdd}
      onDecline={onDecline}
    />
  );
}
