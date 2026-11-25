import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DRIVER_EVENTS, type BoardPlan, type BoardTakeResult, type LatLng, type OfferClosedPayload } from "@rida/shared";
import { addPassenger, errorStatus, getRequestBoard, getRideSocket, serverReason, useAuth, type BoardRideItem, type RequestBoard } from "@rida/mobile-shared";
import { acceptRequest } from "./tripActions";
import { driverActiveRideQueryKey } from "./activeTrip";
import { eligibleRidesQueryKey } from "./requests";

export const requestBoardQueryKey = ["requestBoard"] as const;

/**
 * The request board (2026-11-25): every open request on campus
 * (GET /driver/requests/board), kept live over the socket:
 * - `driver:board_changed` — a request appeared or changed somewhere: refetch;
 * - `ride:offer_closed` — taken, cancelled or expired: it leaves at once;
 * - `driver:requests_changed` (this car's seats changed) and reconnecting: refetch.
 * Polled every 15 s as well, and on coming back to the foreground.
 */
export function useRequestBoard(enabled: boolean, position: LatLng | null) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const active = isAuthenticated && enabled;
  const positionRef = useRef(position);
  positionRef.current = position;

  const query = useQuery({
    queryKey: requestBoardQueryKey,
    queryFn: () => getRequestBoard(positionRef.current),
    enabled: active,
    refetchInterval: 15_000,
  });

  const { refetch } = query;
  useEffect(() => {
    if (!active) return;
    const socket = getRideSocket();
    const again = () => void refetch();
    const onClosed = (payload: OfferClosedPayload) => {
      queryClient.setQueryData<RequestBoard>(requestBoardQueryKey, (board) =>
        board ? { ...board, rides: board.rides.filter((r) => r.rideId !== payload.rideId) } : board,
      );
    };
    socket.on(DRIVER_EVENTS.BOARD_CHANGED, again);
    socket.on(DRIVER_EVENTS.REQUESTS_CHANGED, again);
    socket.on(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    socket.on("connect", again);
    return () => {
      socket.off(DRIVER_EVENTS.BOARD_CHANGED, again);
      socket.off(DRIVER_EVENTS.REQUESTS_CHANGED, again);
      socket.off(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
      socket.off("connect", again);
    };
  }, [active, refetch, queryClient]);

  return query;
}

/** Long enough for a slow database round trip. */
const ADD_TIMEOUT_MS = 20_000;

/**
 * "Add to my trip" (planBoardTake decided the order): with no trip, claim
 * one — the same accept as a pop-up's (lib/tripActions acceptRequest), so
 * the trip screen opens with it — trying the next if it was just taken; then
 * add the rest to that car with the same add the trip screen uses (the
 * server checks seats and the detour each time). One taken by someone else
 * meanwhile is "already taken" and the rest still go in. Every take is
 * marked as from the board. Returns what happened to each, and the trip.
 */
export async function takeFromBoard(
  plan: Extract<BoardPlan, { ok: true }>,
  items: readonly BoardRideItem[],
  car: { rideId: string } | null,
  position: LatLng | null,
): Promise<{ results: BoardTakeResult[]; tripId: string | null }> {
  const byId = new Map(items.map((i) => [i.rideId, i]));
  const results: BoardTakeResult[] = [];
  let tripId = car?.rideId ?? null;
  let queue = [...plan.add];

  if (plan.claim) {
    const candidates = [plan.claim, ...queue];
    queue = [];
    while (candidates.length > 0 && !tripId) {
      const id = candidates.shift()!;
      const item = byId.get(id);
      if (!item) continue;
      const outcome = await acceptRequest(item, "BOARD");
      if (outcome.kind === "accepted") {
        tripId = id;
        results.push({ rideId: id, outcome: "added" });
      } else if (outcome.kind === "gone") {
        results.push(outcome.reason === "TAKEN" ? { rideId: id, outcome: "taken" } : { rideId: id, outcome: "refused", message: "One request is no longer waiting." });
        // A Ride alone request can't be swapped for a Shared one: stop.
        if (item.type === "LONE") break;
      } else {
        results.push({ rideId: id, outcome: "refused", message: outcome.kind === "network" ? "Couldn't reach CampusRide. Try again." : outcome.message });
        return { results, tripId };
      }
    }
    queue = candidates;
  }

  for (const id of queue) {
    if (!tripId) break;
    try {
      await addPassenger(tripId, id, { timeoutMs: ADD_TIMEOUT_MS, position, source: "BOARD" });
      results.push({ rideId: id, outcome: "added" });
    } catch (err) {
      const data = (err as { response?: { data?: { reason?: unknown } } }).response?.data;
      if (errorStatus(err) === 409 && data?.reason === "TAKEN") results.push({ rideId: id, outcome: "taken" });
      else results.push({ rideId: id, outcome: "refused", message: serverReason(err) ?? "One rider couldn't be added." });
    }
  }
  return { results, tripId };
}

/** After a take: the trip, the board and the Home list catch up. */
export function refreshAfterTake(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
  void queryClient.invalidateQueries({ queryKey: requestBoardQueryKey });
  void queryClient.invalidateQueries({ queryKey: eligibleRidesQueryKey });
}
