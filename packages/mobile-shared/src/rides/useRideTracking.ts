import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RIDE_EVENTS,
  type DriverAssignedPayload,
  type DriverLocationPayload,
  type RideCompletedPayload,
  type RideStatusPayload,
} from "@rida/shared";
import { getRide, type GetRideResult } from "./api";
import { getRideSocket, subscribeToRide, unsubscribeFromRide } from "../realtime/socket";

export function rideQueryKey(rideId: string) {
  return ["ride", rideId] as const;
}

/**
 * Drives the rider tracking screen: fetches the ride once via TanStack Query,
 * then subscribes to its `ride:{rideId}` socket room and patches the cached
 * query data as `ride:status` / `ride:driver_assigned` / `ride:completed`
 * events arrive. `ride:driver_location` pings are NOT cached (too frequent) —
 * consumers should subscribe to them separately via `useDriverLocation`.
 */
export function useRideTracking(rideId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = rideQueryKey(rideId ?? "");

  const query = useQuery({
    queryKey,
    queryFn: () => getRide(rideId!),
    enabled: !!rideId,
    // Poll every 12 s while the ride is in a non-terminal transitioning state so
    // the UI converges on true backend state even when a socket event is missed
    // (e.g. timeout-driven transitions from processTimeouts).
    refetchInterval: (q) => {
      const s = q.state.data?.ride?.status;
      return s === "REQUESTED" || s === "AWAITING_RIDER_DECISION" || s === "MATCHED" || s === "ARRIVED"
        ? 12_000
        : false;
    },
  });

  useEffect(() => {
    if (!rideId) return;

    const socket = getRideSocket();
    subscribeToRide(rideId);

    const onStatus = (payload: RideStatusPayload) => {
      if (payload.rideId !== rideId) return;
      queryClient.setQueryData<GetRideResult | undefined>(queryKey, (current?: GetRideResult) =>
        current ? { ...current, ride: { ...current.ride, status: payload.status } } : current,
      );
    };

    const onDriverAssigned = (payload: DriverAssignedPayload) => {
      if (payload.rideId !== rideId) return;
      const { rideId: _rideId, ...driver } = payload;
      queryClient.setQueryData<GetRideResult | undefined>(queryKey, (current?: GetRideResult) =>
        current ? { ...current, ride: { ...current.ride, driverId: driver.driverId }, driver } : current,
      );
    };

    const onCompleted = (payload: RideCompletedPayload) => {
      if (payload.rideId !== rideId) return;
      queryClient.setQueryData<GetRideResult | undefined>(queryKey, (current?: GetRideResult) =>
        current
          ? { ...current, ride: { ...current.ride, status: "COMPLETED" }, fareSummary: payload.fareSummary }
          : current,
      );
    };

    socket.on(RIDE_EVENTS.STATUS, onStatus);
    socket.on(RIDE_EVENTS.DRIVER_ASSIGNED, onDriverAssigned);
    socket.on(RIDE_EVENTS.COMPLETED, onCompleted);

    return () => {
      socket.off(RIDE_EVENTS.STATUS, onStatus);
      socket.off(RIDE_EVENTS.DRIVER_ASSIGNED, onDriverAssigned);
      socket.off(RIDE_EVENTS.COMPLETED, onCompleted);
      unsubscribeFromRide(rideId);
    };
  }, [rideId, queryClient, queryKey]);

  return query;
}

/**
 * Subscribes to `ride:driver_location` pings for a ride. Kept separate from
 * `useRideTracking` since location pings arrive every couple seconds and
 * don't belong in the TanStack Query cache.
 */
export function useDriverLocation(
  rideId: string | undefined,
  onLocation: (payload: DriverLocationPayload) => void,
) {
  useEffect(() => {
    if (!rideId) return;

    const socket = getRideSocket();
    const handler = (payload: DriverLocationPayload) => {
      if (payload.rideId !== rideId) return;
      onLocation(payload);
    };

    socket.on(RIDE_EVENTS.DRIVER_LOCATION, handler);
    return () => {
      socket.off(RIDE_EVENTS.DRIVER_LOCATION, handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId]);
}
