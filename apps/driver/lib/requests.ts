import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { DRIVER_EVENTS } from "@rida/shared";
import { getEligibleRides, getRideSocket, useAuth } from "@rida/mobile-shared";

export const eligibleRidesQueryKey = ["eligibleRides"] as const;

/**
 * The requests this driver can claim right now (/driver/rides/eligible),
 * polled every 10s and refreshed the moment a new request is broadcast.
 * One cache entry, so Home's "Requests near you (N)" and the list agree.
 */
export function useRequestsNearYou(enabled: boolean) {
  const { isAuthenticated } = useAuth();
  const active = isAuthenticated && enabled;
  const query = useQuery({
    queryKey: eligibleRidesQueryKey,
    queryFn: getEligibleRides,
    enabled: active,
    refetchInterval: 10_000,
  });

  const { refetch } = query;
  useEffect(() => {
    if (!active) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetch();
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    };
  }, [active, refetch]);

  return query;
}
