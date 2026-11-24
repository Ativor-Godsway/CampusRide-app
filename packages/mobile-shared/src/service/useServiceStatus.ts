import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  MY_SERVICE_STATUS_PATH,
  SERVICE_NOTIFY_PATH,
  SERVICE_STATUS_EVENT,
  holdServiceStatus,
  serviceViewAt,
  type HeldServiceStatus,
  type ServiceView,
} from "@rida/shared";
import { api } from "../auth/apiClient";
import { useAuth } from "../auth/AuthContext";
import { getRideSocket } from "../realtime/socket";

/**
 * Service hours in the apps (@rida/shared service/serviceHours.ts): whether
 * riders can book now, and what to show when they can't.
 *
 * Asked from GET /me/service-status on opening, every minute, and again when
 * the socket (re)connects; between answers the server pushes every change
 * over the socket (`service:status`), so the Home banner updates without a
 * restart. Times run on the server's clock. A failed or unreadable answer
 * (an older server, no network) shows no banner: the server still decides,
 * and refuses with words the app shows.
 */

const MINUTE_MS = 60_000;
/** Re-render this often so "Closes at 5:00 PM" and closing time show up by themselves. */
const TICK_MS = 15_000;

export const serviceStatusQueryKey = ["service-status"] as const;

export async function fetchServiceStatus(): Promise<HeldServiceStatus | null> {
  const response = await api.get<unknown>(MY_SERVICE_STATUS_PATH);
  return holdServiceStatus(response.data, Date.now());
}

/** Ask again now (after a refused request, say). */
export function refreshServiceStatus(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: serviceStatusQueryKey });
}

export interface ServiceStatusHook {
  held: HeldServiceStatus | null;
  view: ServiceView;
  /** The phone's clock at the last tick (for driverServiceNotice). */
  now: number;
  notifyMe: boolean;
  /** "Notify me when you open" on or off. Throws when the server refuses (it opened meanwhile). */
  setNotifyMe: (on: boolean) => Promise<void>;
}

export function useServiceStatus(): ServiceStatusHook {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: serviceStatusQueryKey,
    queryFn: fetchServiceStatus,
    enabled: isAuthenticated,
    staleTime: 30_000,
    refetchInterval: MINUTE_MS,
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    const socket = getRideSocket();
    const onStatus = (payload: unknown) => {
      queryClient.setQueryData<HeldServiceStatus | null>(
        serviceStatusQueryKey,
        (previous) => holdServiceStatus(payload, Date.now(), previous) ?? previous ?? null,
      );
    };
    // Changes made while disconnected (a deploy, no network) aren't replayed: ask.
    const onConnect = () => refreshServiceStatus(queryClient);
    socket.on(SERVICE_STATUS_EVENT, onStatus);
    socket.on("connect", onConnect);
    return () => {
      socket.off(SERVICE_STATUS_EVENT, onStatus);
      socket.off("connect", onConnect);
    };
  }, [isAuthenticated, queryClient]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const held = isAuthenticated ? (data ?? null) : null;

  const setNotifyMe = useCallback(
    async (on: boolean) => {
      try {
        if (on) await api.post(SERVICE_NOTIFY_PATH, {});
        else await api.delete(SERVICE_NOTIFY_PATH);
      } catch (err) {
        refreshServiceStatus(queryClient);
        throw err;
      }
      queryClient.setQueryData<HeldServiceStatus | null>(serviceStatusQueryKey, (previous) =>
        previous ? { ...previous, notifyMe: on } : previous,
      );
    },
    [queryClient],
  );

  return { held, view: serviceViewAt(held, now), now, notifyMe: held?.notifyMe ?? false, setNotifyMe };
}
