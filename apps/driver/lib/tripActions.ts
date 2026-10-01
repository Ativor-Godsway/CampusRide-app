import { useSyncExternalStore } from "react";
import {
  ACTION_RETRY_DELAYS_MS,
  classifyActionFailure,
  refusalMessage,
  type PassengerStatus,
} from "@rida/shared";
import {
  addPassenger,
  driverClaimRide,
  errorStatus,
  passengerArrived,
  passengerCancel,
  passengerDropoff,
  passengerNoShow,
  passengerPickup,
  serverReason,
  type EligibleRideItem,
  type FillSuggestion,
  type PassengerInCar,
} from "@rida/mobile-shared";

/**
 * Driver actions that feel instant (like the online toggle).
 *
 * Tapping an action changes the screen at once; the request goes in the
 * background, one at a time and in order (a pickup can't overtake its
 * "I'm here"). A failure that isn't a real answer — no response, a timeout,
 * a 5xx — is retried quietly, as long as it takes: the server treats a
 * repeat as a no-op, so an action whose first attempt actually landed is
 * safe to send again. Only a real refusal (a 4xx) puts the screen back, with
 * the server's reason.
 *
 * This lives outside any screen, so leaving the trip screen mid-send never
 * loses an action.
 */

/** Long enough for a slow database round trip; the screen has already moved on. */
const ACTION_TIMEOUT_MS = 25_000;

export type PassengerAction = "arrived" | "pickup" | "dropoff" | "cancel" | "no-show";

const TARGET: Record<PassengerAction, PassengerStatus> = {
  arrived: "ARRIVED",
  pickup: "PICKED_UP",
  dropoff: "DROPPED_OFF",
  cancel: "CANCELLED",
  "no-show": "CANCELLED",
};

const CALL: Record<PassengerAction, (rideId: string, passengerId: string, o: { timeoutMs: number }) => Promise<unknown>> = {
  arrived: passengerArrived,
  pickup: passengerPickup,
  dropoff: passengerDropoff,
  cancel: passengerCancel,
  "no-show": passengerNoShow,
};

const FALLBACK: Record<PassengerAction, string> = {
  arrived: "Couldn't mark that you're here.",
  pickup: "Couldn't mark the pickup.",
  dropoff: "Couldn't mark the drop-off.",
  cancel: "Couldn't remove this rider.",
  "no-show": "Couldn't mark the no-show.",
};

/** How far along a seat is; the screen never shows a seat going backwards. */
const RANK: Record<PassengerStatus, number> = { WAITING: 0, ARRIVED: 1, PICKED_UP: 2, DROPPED_OFF: 3, CANCELLED: 3 };

export class ActionRefusedError extends Error {}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sends one request until it gets a real answer. Retries "no answer" failures
 * with growing pauses (then every 30 s); throws ActionRefusedError with the
 * server's reason on a refusal.
 */
export async function sendUntilAnswered<T>(
  call: (timeoutMs: number) => Promise<T>,
  fallback: string,
  onRetrying: (retrying: boolean) => void,
  isAbandoned: () => boolean = () => false,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call(ACTION_TIMEOUT_MS);
      onRetrying(false);
      return result;
    } catch (err) {
      if (classifyActionFailure(errorStatus(err)) === "refused") {
        onRetrying(false);
        throw new ActionRefusedError(refusalMessage(serverReason(err), fallback));
      }
      if (isAbandoned()) throw new ActionRefusedError(fallback);
      onRetrying(true);
      await wait(ACTION_RETRY_DELAYS_MS[Math.min(attempt, ACTION_RETRY_DELAYS_MS.length - 1)]!);
    }
  }
}

interface SeatOverlay {
  status: PassengerStatus;
  arrivedAt?: string;
}

interface PendingAdd {
  suggestion: FillSuggestion;
  /** The fare the preview quoted, shown on the provisional seat. */
  farePesewas?: number;
  /** The seat the server created, once it has answered. */
  passengerId?: string;
}

export interface PendingClaim {
  rideId: string;
  request: EligibleRideItem;
  /** "sending" until the server confirms; "refused" with a reason if it said no. */
  state: "sending" | "confirmed" | "refused";
  message: string | null;
}

interface Snapshot {
  rideId: string | null;
  seats: Record<string, SeatOverlay>;
  adds: Record<string, PendingAdd>;
  /** A request is being retried because CampusRide didn't answer. */
  retrying: boolean;
  /** Latest refusal to show the driver, with an id so each is shown once. */
  refusal: { id: number; message: string } | null;
  claim: PendingClaim | null;
}

let state: Snapshot = { rideId: null, seats: {}, adds: {}, retrying: false, refusal: null, claim: null };
const listeners = new Set<() => void>();
let chain: Promise<void> = Promise.resolve();
let retryingCount = 0;
let refusalId = 0;
/** Bumped per seat on a refusal, so queued follow-ups for it are dropped. */
const seatGeneration = new Map<string, number>();
let onServerChanged: () => void = () => {};

function set(patch: Partial<Snapshot>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function setRetrying(on: boolean) {
  retryingCount = Math.max(0, retryingCount + (on ? 1 : -1));
  if (state.retrying !== retryingCount > 0) set({ retrying: retryingCount > 0 });
}

function refuse(message: string) {
  refusalId += 1;
  set({ refusal: { id: refusalId, message } });
}

/** Called after every answered action so the trip data is refetched. */
export function setTripActionsRefresh(refresh: () => void) {
  onServerChanged = refresh;
}

/** Forget overlays from a previous trip. */
function forRide(rideId: string) {
  if (state.rideId !== rideId) set({ rideId, seats: {}, adds: {} });
}

function enqueue(job: () => Promise<void>) {
  chain = chain.then(job, job);
}

/** Run a seat action: the screen changes now, the request follows. */
export function runPassengerAction(rideId: string, passengerId: string, action: PassengerAction) {
  forRide(rideId);
  const target = TARGET[action];
  set({
    seats: {
      ...state.seats,
      [passengerId]: { status: target, ...(action === "arrived" ? { arrivedAt: new Date().toISOString() } : {}) },
    },
  });
  const generation = seatGeneration.get(passengerId) ?? 0;
  let retrying = false;
  enqueue(async () => {
    if ((seatGeneration.get(passengerId) ?? 0) !== generation) return;
    try {
      await sendUntilAnswered(
        (timeoutMs) => CALL[action](rideId, passengerId, { timeoutMs }),
        FALLBACK[action],
        (on) => {
          if (on !== retrying) setRetrying(on);
          retrying = on;
        },
      );
    } catch (err) {
      seatGeneration.set(passengerId, generation + 1);
      const { [passengerId]: _dropped, ...rest } = state.seats;
      set({ seats: rest });
      refuse((err as Error).message);
    } finally {
      if (retrying) setRetrying(false);
      onServerChanged();
    }
  });
}

/** Add a waiting rider to the car: they appear at once, the request follows. */
export function runAddRider(rideId: string, suggestion: FillSuggestion, farePesewas?: number) {
  forRide(rideId);
  set({ adds: { ...state.adds, [suggestion.requestRideId]: { suggestion, farePesewas } } });
  let retrying = false;
  enqueue(async () => {
    try {
      const result = await sendUntilAnswered(
        (timeoutMs) => addPassenger(rideId, suggestion.requestRideId, { timeoutMs }),
        "Couldn't add this rider.",
        (on) => {
          if (on !== retrying) setRetrying(on);
          retrying = on;
        },
      );
      // The new seat is the last one the server lists; keep showing the
      // provisional row until the trip data includes it (no flicker).
      const pending = state.adds[suggestion.requestRideId];
      const passengerId = result.passengers[result.passengers.length - 1]?.id;
      if (pending && passengerId) {
        set({ adds: { ...state.adds, [suggestion.requestRideId]: { ...pending, passengerId } } });
      }
      onServerChanged();
    } catch (err) {
      const { [suggestion.requestRideId]: _dropped, ...rest } = state.adds;
      set({ adds: rest });
      refuse((err as Error).message);
      onServerChanged();
    } finally {
      if (retrying) setRetrying(false);
    }
  });
}

/** Accept a request: the trip opens at once, the claim follows. */
export function runClaim(request: EligibleRideItem) {
  set({ claim: { rideId: request.rideId, request, state: "sending", message: null } });
  void (async () => {
    try {
      await sendUntilAnswered(
        (timeoutMs) => driverClaimRide(request.rideId, { timeoutMs }),
        "Couldn't accept this request.",
        (on) => setRetrying(on),
      );
      if (state.claim?.rideId === request.rideId) set({ claim: { ...state.claim, state: "confirmed" } });
    } catch (err) {
      if (state.claim?.rideId === request.rideId) {
        set({ claim: { ...state.claim, state: "refused", message: (err as Error).message } });
      }
    } finally {
      onServerChanged();
    }
  })();
}

export function clearClaim() {
  set({ claim: null });
}

/**
 * The trip's passengers as the driver should see them: the server's data
 * with this device's not-yet-confirmed actions on top, plus riders being
 * added. A seat never moves backwards while its action is in flight.
 */
export function overlayPassengers(rideId: string, passengers: readonly PassengerInCar[]): PassengerInCar[] {
  if (state.rideId !== rideId) return [...passengers];
  const merged = passengers.map((p) => {
    const o = state.seats[p.id];
    if (!o || RANK[p.status] >= RANK[o.status]) return p;
    return { ...p, status: o.status, arrivedAt: o.arrivedAt ?? p.arrivedAt ?? null };
  });
  const present = new Set(passengers.map((p) => p.id));
  for (const { suggestion, passengerId, farePesewas } of Object.values(state.adds)) {
    // Once the server lists the new seat, the provisional row goes.
    if (passengerId && present.has(passengerId)) continue;
    merged.push({
      id: `pending:${suggestion.requestRideId}`,
      riderId: "",
      riderName: null,
      riderPhone: null,
      pickupZoneId: suggestion.pickupZoneId,
      dropoffZoneId: suggestion.dropoffZoneId,
      pickupZoneName: suggestion.pickupZoneName,
      dropoffZoneName: suggestion.dropoffZoneName,
      lockedFare: farePesewas ?? null,
      status: "WAITING",
      arrivedAt: null,
    });
  }
  return merged;
}

/** Drops overlays the server has caught up with (call when trip data arrives). */
export function settleWith(rideId: string, passengers: readonly PassengerInCar[]) {
  if (state.rideId !== rideId) return;
  let changed = false;
  const seats = { ...state.seats };
  for (const p of passengers) {
    const o = seats[p.id];
    if (o && RANK[p.status] >= RANK[o.status]) {
      delete seats[p.id];
      changed = true;
    }
  }
  const adds = { ...state.adds };
  for (const [key, { passengerId }] of Object.entries(adds)) {
    if (passengerId && passengers.some((p) => p.id === passengerId)) {
      delete adds[key];
      changed = true;
    }
  }
  if (changed) set({ seats, adds });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTripActions(): Snapshot {
  return useSyncExternalStore(subscribe, () => state);
}
