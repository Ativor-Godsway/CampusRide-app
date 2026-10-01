/**
 * "What happens to my trip if I add this rider?" — the route preview shown
 * before a driver adds a rider to a shared car.
 *
 * It reuses the trip's own stop ordering (planTripStops) on the car with the
 * new rider in it, so the preview is exactly what the trip screen will show
 * once the rider is added: same order, same route, no jump on accept. The
 * extra time is the difference between the two plans' driving times, using
 * the stored zone-to-zone road routes where they exist.
 */
import type { PathPoint } from "../geo/polyline";
import { planSeconds, tripPath, type RouteLookup } from "../geo/tripRoute";
import { planTripStops, type TripPassenger, type TripStop, type TripZone } from "./tripStops";

export interface AddRiderCandidate {
  /** The waiting request being considered. */
  requestRideId: string;
  pickupZoneId: string;
  dropoffZoneId: string;
  /** What the new rider would pay. */
  farePesewas: number;
}

export interface PreviewStop extends TripStop {
  /** True for the new rider's pickup and drop-off. */
  isNew: boolean;
}

export interface AddRiderPreview {
  /** The trip's remaining stops with the new rider slotted in, in order. */
  stops: PreviewStop[];
  /** Where the new pickup and drop-off land in `stops` (0-based). */
  pickupIndex: number;
  dropoffIndex: number;
  /** The route as it is now, and as it would be. */
  currentPath: PathPoint[];
  proposedPath: PathPoint[];
  currentSeconds: number;
  proposedSeconds: number;
  /** proposedSeconds − currentSeconds, never below zero. */
  addedSeconds: number;
  /** For "adds ~X min": at least 1, since a new rider always means two more stops. */
  addedMinutes: number;
}

/** Seat id given to the rider being previewed (never a real RidePassenger id). */
export function previewPassengerId(requestRideId: string): string {
  return `new:${requestRideId}`;
}

export function previewAddRider(input: {
  passengers: readonly TripPassenger[];
  candidate: AddRiderCandidate;
  zones: readonly TripZone[];
  routes: RouteLookup;
  /** The driver's position; null plans from the first stop. */
  from: PathPoint | null;
}): AddRiderPreview | null {
  const zoneMap = new Map(input.zones.map((z) => [z.id, z]));
  if (!zoneMap.has(input.candidate.pickupZoneId) || !zoneMap.has(input.candidate.dropoffZoneId)) return null;

  const newId = previewPassengerId(input.candidate.requestRideId);
  const current = planTripStops({ passengers: input.passengers, zones: zoneMap, from: input.from });
  const proposed = planTripStops({
    passengers: [
      ...input.passengers,
      {
        id: newId,
        riderName: null,
        riderPhone: null,
        pickupZoneId: input.candidate.pickupZoneId,
        dropoffZoneId: input.candidate.dropoffZoneId,
        lockedFare: input.candidate.farePesewas,
        status: "WAITING",
        arrivedAt: null,
      },
    ],
    zones: zoneMap,
    from: input.from,
  });

  const stops: PreviewStop[] = proposed.upcoming.map((s) => ({
    ...s,
    isNew: s.passengerId === newId,
    riderFirstName: s.passengerId === newId ? "New rider" : s.riderFirstName,
  }));
  const pickupIndex = stops.findIndex((s) => s.isNew && s.kind === "PICKUP");
  const dropoffIndex = stops.findIndex((s) => s.isNew && s.kind === "DROPOFF");

  const currentZones = current.upcoming.map((s) => s.zone);
  const proposedZones = stops.map((s) => s.zone);
  const currentSeconds = planSeconds(input.from, currentZones, input.zones, input.routes);
  const proposedSeconds = planSeconds(input.from, proposedZones, input.zones, input.routes);
  const addedSeconds = Math.max(0, proposedSeconds - currentSeconds);

  return {
    stops,
    pickupIndex,
    dropoffIndex,
    currentPath: tripPath(input.from, currentZones, input.zones, input.routes),
    proposedPath: tripPath(input.from, proposedZones, input.zones, input.routes),
    currentSeconds,
    proposedSeconds,
    addedSeconds,
    addedMinutes: Math.max(1, Math.round(addedSeconds / 60)),
  };
}

/** "+1 rider · adds ~3 min · +GH₵5" */
export function addRiderPreviewLabel(addedMinutes: number, fareText: string): string {
  return `+1 rider · adds ~${addedMinutes} min · +${fareText}`;
}
