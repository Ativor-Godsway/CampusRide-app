import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SCHEDULE_EVENTS,
  SCHEDULE_PATHS,
  type DriverScheduleResponse,
  type ScheduleAcceptedVia,
  type ScheduleOptions,
  type ScheduledBookingView,
} from "@rida/shared";
import { api } from "../auth/apiClient";
import { useAuth } from "../auth/AuthContext";
import { getRideSocket } from "../realtime/socket";
import type { RideEndBody } from "./api";

/**
 * Scheduled Shared rides in the apps (rules: @rida/shared rides/scheduled.ts,
 * server: routes/scheduled.ts). A refused action is thrown as an axios error
 * whose response body has `error` (words to show) and `code`.
 */

// ─── Rider ──────────────────────────────────────────────────────────────────

export const scheduleOptionsQueryKey = (pickup: RideEndBody, dropoff: RideEndBody, seats: number) =>
  ["schedule", "options", pickup.placeId ?? `${pickup.latitude},${pickup.longitude}`, dropoff.placeId ?? `${dropoff.latitude},${dropoff.longitude}`, seats] as const;

export async function getScheduleOptions(pickup: RideEndBody, dropoff: RideEndBody, seats: number): Promise<ScheduleOptions> {
  const res = await api.post<ScheduleOptions>(SCHEDULE_PATHS.options, { pickup, dropoff, seats });
  return res.data;
}

export interface BookScheduledInput {
  arriveBy: string;
  pickup: RideEndBody;
  dropoff: RideEndBody;
  seats: number;
  shownFarePesewas: number;
  pickupNote?: string | null;
  carId?: string | null;
}

export async function bookScheduledRide(input: BookScheduledInput): Promise<ScheduledBookingView> {
  const res = await api.post<{ booking: ScheduledBookingView }>(SCHEDULE_PATHS.book, {
    ...input,
    ...(input.carId ? { carId: input.carId } : { carId: undefined }),
  });
  return res.data.booking;
}

export interface MyScheduledRide {
  booking: ScheduledBookingView | null;
  enabled: boolean;
  intro: { show: boolean };
}

export const myScheduledRideQueryKey = ["schedule", "mine"] as const;

export async function getMyScheduledRide(): Promise<MyScheduledRide> {
  const res = await api.get<MyScheduledRide>(SCHEDULE_PATHS.mine);
  return { booking: res.data.booking ?? null, enabled: res.data.enabled !== false, intro: { show: res.data.intro?.show === true } };
}

export async function cancelScheduledRide(bookingId: string): Promise<{ strike: boolean; blockedUntil: string | null }> {
  const res = await api.post<{ strike: boolean; blockedUntil: string | null }>(`${SCHEDULE_PATHS.booking(bookingId)}/cancel`, {});
  return res.data;
}

export async function sayImComing(bookingId: string): Promise<void> {
  await api.post(`${SCHEDULE_PATHS.booking(bookingId)}/coming`, {});
}

/**
 * The rider's upcoming scheduled ride (Home card), kept fresh: every minute,
 * and at once when the server says it changed (a driver accepted, someone
 * joined, it became a trip or a live request).
 */
export function useMyScheduledRide() {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();
  const enabled = isAuthenticated && user?.role === "RIDER";
  useEffect(() => {
    if (!enabled) return;
    const socket = getRideSocket();
    const onChange = () => {
      void queryClient.invalidateQueries({ queryKey: myScheduledRideQueryKey });
      // It may have become a trip or a live request.
      void queryClient.invalidateQueries({ queryKey: ["activeRide"] });
    };
    socket.on(SCHEDULE_EVENTS.RIDER_CHANGED, onChange);
    return () => {
      socket.off(SCHEDULE_EVENTS.RIDER_CHANGED, onChange);
    };
  }, [enabled, queryClient]);
  return useQuery({ queryKey: myScheduledRideQueryKey, queryFn: getMyScheduledRide, enabled, refetchInterval: 60_000, staleTime: 15_000 });
}

// ─── Driver ─────────────────────────────────────────────────────────────────

export const driverScheduleQueryKey = ["schedule", "driver"] as const;

export async function getDriverSchedule(): Promise<DriverScheduleResponse> {
  const res = await api.get<DriverScheduleResponse>(SCHEDULE_PATHS.driver);
  return { online: res.data.online === true, mine: res.data.mine ?? [], open: res.data.open ?? [], serverTime: res.data.serverTime };
}

export async function acceptScheduledCar(carId: string, source: ScheduleAcceptedVia): Promise<DriverScheduleResponse> {
  const res = await api.post<DriverScheduleResponse>(`${SCHEDULE_PATHS.driverCar(carId)}/accept`, { source });
  return res.data;
}

export async function giveBackScheduledCar(carId: string): Promise<DriverScheduleResponse> {
  const res = await api.post<DriverScheduleResponse>(`${SCHEDULE_PATHS.driverCar(carId)}/cancel`, {});
  return res.data;
}

/** The words a refused scheduled-ride action came back with, or a fallback. */
export function scheduleErrorText(err: unknown, fallback = "That didn't work. Check your connection and try again."): string {
  const body = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

/** A refused scheduled-ride action's code ("SLOT_CLOSED", "SCHEDULE_OVERLAP", …), if any. */
export function scheduleErrorCode(err: unknown): string | null {
  const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof code === "string" ? code : null;
}
