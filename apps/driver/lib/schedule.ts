import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SCHEDULE_EVENTS, type DriverScheduledCarView, type ScheduleAcceptedVia } from "@rida/shared";
import {
  acceptScheduledCar,
  driverScheduleQueryKey,
  getDriverSchedule,
  getRideSocket,
  giveBackScheduledCar,
  useAuth,
} from "@rida/mobile-shared";
import { requestBoardQueryKey } from "./board";
import { driverActiveRideQueryKey } from "./activeTrip";

/**
 * Scheduled rides in the driver app (rules: @rida/shared rides/scheduled.ts):
 * the Schedule tab's data, kept fresh by the server's nudges; a car's start
 * opens its trip; offers pop up one at a time.
 */

export function useDriverSchedule() {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();
  const router = useRouter();
  const enabled = isAuthenticated && user?.role === "DRIVER";
  useEffect(() => {
    if (!enabled) return;
    const socket = getRideSocket();
    const onChange = (payload?: { startedRideId?: string }) => {
      void queryClient.invalidateQueries({ queryKey: driverScheduleQueryKey });
      if (payload?.startedRideId) {
        // The scheduled car is now a normal trip: open it.
        void queryClient.invalidateQueries({ queryKey: driverActiveRideQueryKey });
        router.navigate(`/ride/${payload.startedRideId}`);
      }
    };
    socket.on(SCHEDULE_EVENTS.DRIVER_CHANGED, onChange);
    return () => {
      socket.off(SCHEDULE_EVENTS.DRIVER_CHANGED, onChange);
    };
  }, [enabled, queryClient, router]);
  return useQuery({ queryKey: driverScheduleQueryKey, queryFn: getDriverSchedule, enabled, refetchInterval: 60_000 });
}

/** Accept or give back, then refresh the Schedule tab and the board. */
export function useScheduleActions() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: driverScheduleQueryKey });
    void queryClient.invalidateQueries({ queryKey: requestBoardQueryKey });
  };
  return {
    accept: async (carId: string, source: ScheduleAcceptedVia) => {
      const next = await acceptScheduledCar(carId, source);
      queryClient.setQueryData(driverScheduleQueryKey, next);
      refresh();
    },
    giveBack: async (carId: string) => {
      const next = await giveBackScheduledCar(carId);
      queryClient.setQueryData(driverScheduleQueryKey, next);
      refresh();
    },
  };
}

/** Scheduled offers as they arrive (the pop-up), newest last; dismissed ones don't come back this session. */
const dismissed = new Set<string>();

export function useScheduledOffers(): { offer: DriverScheduledCarView | null; dismiss: (carId: string) => void } {
  const { isAuthenticated, user } = useAuth();
  const [queue, setQueue] = useState<DriverScheduledCarView[]>([]);
  const enabled = isAuthenticated && user?.role === "DRIVER";
  useEffect(() => {
    if (!enabled) return;
    const socket = getRideSocket();
    const onOffer = (view: DriverScheduledCarView) => {
      if (!view?.carId || dismissed.has(view.carId)) return;
      setQueue((q) => (q.some((v) => v.carId === view.carId) ? q : [...q, view]));
    };
    socket.on(SCHEDULE_EVENTS.OFFER, onOffer);
    return () => {
      socket.off(SCHEDULE_EVENTS.OFFER, onOffer);
    };
  }, [enabled]);
  return {
    offer: queue[0] ?? null,
    dismiss: (carId) => {
      dismissed.add(carId);
      setQueue((q) => q.filter((v) => v.carId !== carId));
    },
  };
}
