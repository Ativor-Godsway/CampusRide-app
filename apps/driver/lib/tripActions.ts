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
  getDriverActiveRide,
  passengerArrived,
  passengerCancel,
  passengerDropoff,
  passengerPickup,
  serverReason,
  type EligibleRideItem,
  type FillSuggestion,
  type PassengerInCar,
  type RideWithZones,
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
 *
 * Riders who aren't confirmed yet — a request just accepted ("claim:…") or a
 * rider just added ("pending:…") — get a provisional seat id. They show up
 * and can be acted on at once; their actions wait in the queue behind the
 * accept/add and go out with the real id once the server has given it.
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
  // "Rider didn't show" is the passenger cancel with a no-show reason.
  "no-show": (rideId, passengerId, o) => passengerCancel(rideId, passengerId, { ...o, reason: "NO_SHOW" }),
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
  /** The rider's real seat id, once known. */
  passengerId: string | null;
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
let hooks: { refresh: () => void; onRide: (ride: RideWithZones | null) => void } = {
  refresh: () => {},
  onRide: () => {},
};

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

/**
 * Wire the store to the app: `refresh` after every answered action (a quiet
 * background sync — the screen never waits for it), `onRide` with fresh trip
 * data the store fetched itself.
 */
export function configureTripActions(next: typeof hooks) {
  hooks = next;
}

/** Forget overlays from a previous trip. */
function forRide(rideId: string) {
  if (state.rideId !== rideId) set({ rideId, seats: {}, adds: {} });
}

function enqueue(job: () => Promise<void>) {
  chain = chain.then(job, job);
}

const CLAIM_PREFIX = "claim:";
const PENDING_PREFIX = "pending:";

/** The provisional seat of the rider whose request was just accepted. */
export function claimPassengerId(rideId: string): string {
  return `${CLAIM_PREFIX}${rideId}`;
}

/** The real seat id behind a (possibly provisional) one, or null if it never got one. */
function resolveId(passengerId: string): string | null {
  if (passengerId.startsWith(CLAIM_PREFIX)) {
    const rideId = passengerId.slice(CLAIM_PREFIX.length);
    return state.claim?.rideId === rideId ? state.claim.passengerId : null;
  }
  if (passengerId.startsWith(PENDING_PREFIX)) {
    return state.adds[passengerId.slice(PENDING_PREFIX.length)]?.passengerId ?? null;
  }
  return passengerId;
}

/** A provisional seat got its real id: carry its on-screen progress over. */
function moveSeat(fromId: string, toId: string) {
  const o = state.seats[fromId];
  if (!o) return;
  const { [fromId]: _moved, ...rest } = state.seats;
  const existing = rest[toId];
  set({ seats: { ...rest, [toId]: existing && RANK[existing.status] >= RANK[o.status] ? existing : o } });
}

function dropSeat(id: string) {
  if (!state.seats[id]) return;
  const { [id]: _dropped, ...rest } = state.seats;
  set({ seats: rest });
}

/** Run a seat action: the screen changes now, the request follows. */
export function runPassengerAction(rideId: string, passengerId: string, action: PassengerAction) {
  forRide(rideId);
  const target = TARGET[action];
  const current = state.seats[passengerId];
  set({
    seats: {
      ...state.seats,
      [passengerId]: {
        status: target,
        ...(action === "arrived" ? { arrivedAt: new Date().toISOString() } : current?.arrivedAt ? { arrivedAt: current.arrivedAt } : {}),
      },
    },
  });
  const generation = seatGeneration.get(passengerId) ?? 0;
  let retrying = false;
  enqueue(async () => {
    if ((seatGeneration.get(passengerId) ?? 0) !== generation) return;
    // A provisional seat whose accept/add was refused: that refusal has
    // already been shown; just drop the step.
    const realId = resolveId(passengerId);
    if (!realId) {
      dropSeat(passengerId);
      return;
    }
    if (realId !== passengerId) moveSeat(passengerId, realId);
    try {
      await sendUntilAnswered(
        (timeoutMs) => CALL[action](rideId, realId, { timeoutMs }),
        FALLBACK[action],
        (on) => {
          if (on !== retrying) setRetrying(on);
          retrying = on;
        },
      );
    } catch (err) {
      seatGeneration.set(passengerId, generation + 1);
      seatGeneration.set(realId, (seatGeneration.get(realId) ?? 0) + 1);
      dropSeat(passengerId);
      dropSeat(realId);
      refuse((err as Error).message);
    } finally {
      if (retrying) setRetrying(false);
      hooks.refresh();
    }
  });
}

/** Add a waiting rider to the car: they appear at once, the request follows. */
export function runAddRider(
  rideId: string,
  suggestion: FillSuggestion,
  farePesewas?: number,
  /** Where the driver is, for the server's detour check on a moving car. */
  position?: { latitude: number; longitude: number } | null,
) {
  forRide(rideId);
  set({ adds: { ...state.adds, [suggestion.requestRideId]: { suggestion, farePesewas } } });
  let retrying = false;
  enqueue(async () => {
    try {
      const result = await sendUntilAnswered(
        (timeoutMs) => addPassenger(rideId, suggestion.requestRideId, { timeoutMs, position }),
        "Couldn't add this rider.",
        (on) => {
          if (on !== retrying) setRetrying(on);
          retrying = on;
        },
      );
      // The new seat is the last one the server lists. Keep showing the
      // provisional row until the trip data includes it (no flicker).
      const pending = state.adds[suggestion.requestRideId];
      const passengerId = result.passengers[result.passengers.length - 1]?.id;
      if (pending && passengerId) {
        set({ adds: { ...state.adds, [suggestion.requestRideId]: { ...pending, passengerId } } });
        moveSeat(`${PENDING_PREFIX}${suggestion.requestRideId}`, passengerId);
      }
    } catch (err) {
      const { [suggestion.requestRideId]: _dropped, ...rest } = state.adds;
      set({ adds: rest });
      dropSeat(`${PENDING_PREFIX}${suggestion.requestRideId}`);
      refuse((err as Error).message);
    } finally {
      if (retrying) setRetrying(false);
      hooks.refresh();
    }
  });
}

/**
 * Accept a request: the trip opens at once (a provisional trip built from
 * the request), the claim follows. Once the server confirms, the store
 * fetches the trip itself to learn the rider's seat id and hands it to the
 * app (`onRide`), so nothing waits on a poll.
 */
export function runClaim(request: EligibleRideItem) {
  forRide(request.rideId);
  set({ claim: { rideId: request.rideId, request, state: "sending", message: null, passengerId: null } });
  let retrying = false;
  const onRetrying = (on: boolean) => {
    if (on !== retrying) setRetrying(on);
    retrying = on;
  };
  enqueue(async () => {
    try {
      await sendUntilAnswered(
        (timeoutMs) => driverClaimRide(request.rideId, { timeoutMs }),
        "Couldn't accept this request.",
        onRetrying,
      );
      const ride = await sendUntilAnswered(() => getDriverActiveRide(), "Couldn't load the trip.", onRetrying).catch(
        () => null,
      );
      const seat =
        ride && ride.id === request.rideId
          ? (ride.passengers.find((p) => p.riderId === ride.riderId) ?? ride.passengers[0])
          : undefined;
      if (state.claim?.rideId === request.rideId) {
        set({ claim: { ...state.claim, state: "confirmed", passengerId: seat?.id ?? null } });
      }
      if (seat) moveSeat(claimPassengerId(request.rideId), seat.id);
      if (ride) hooks.onRide(ride);
    } catch (err) {
      if (state.claim?.rideId === request.rideId) {
        set({ claim: { ...state.claim, state: "refused", message: (err as Error).message } });
      }
      dropSeat(claimPassengerId(request.rideId));
    } finally {
      if (retrying) setRetrying(false);
      hooks.refresh();
    }
  });
}

export function clearClaim() {
  set({ claim: null });
}

function applySeat(p: PassengerInCar): PassengerInCar {
  const o = state.seats[p.id];
  if (!o || RANK[p.status] >= RANK[o.status]) return p;
  return { ...p, status: o.status, arrivedAt: o.arrivedAt ?? p.arrivedAt ?? null };
}

/**
 * The trip's passengers as the driver should see them: the server's data
 * with this device's not-yet-confirmed actions on top, plus riders being
 * added. A seat never moves backwards while its action is in flight.
 */
export function overlayPassengers(rideId: string, passengers: readonly PassengerInCar[]): PassengerInCar[] {
  if (state.rideId !== rideId) return [...passengers];
  const merged = passengers.map(applySeat);
  const present = new Set(passengers.map((p) => p.id));
  for (const { suggestion, passengerId, farePesewas } of Object.values(state.adds)) {
    // Once the server lists the new seat, the provisional row goes.
    if (passengerId && present.has(passengerId)) continue;
    merged.push(
      applySeat({
        id: passengerId ?? `${PENDING_PREFIX}${suggestion.requestRideId}`,
        riderId: "",
        riderName: suggestion.riderFirstName ?? null,
        riderPhone: null,
        pickupZoneId: suggestion.pickupZoneId,
        dropoffZoneId: suggestion.dropoffZoneId,
        pickupZoneName: suggestion.pickupZoneName,
        dropoffZoneName: suggestion.dropoffZoneName,
        lockedFare: farePesewas ?? null,
        status: "WAITING",
        arrivedAt: null,
      }),
    );
  }
  return merged;
}

/**
 * True once this device has dropped off (or removed) everyone on the trip —
 * before the server has confirmed. Home, the banner and the trip screen
 * treat the trip as over from that moment.
 */
export function finishedLocally(ride: Pick<RideWithZones, "id" | "passengers">): boolean {
  if (state.rideId !== ride.id) return false;
  const seats = overlayPassengers(ride.id, ride.passengers);
  return (
    seats.length > 0 &&
    seats.every((p) => p.status === "DROPPED_OFF" || p.status === "CANCELLED") &&
    seats.some((p) => p.status === "DROPPED_OFF")
  );
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
