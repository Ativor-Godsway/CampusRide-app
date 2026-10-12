import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DRIVER_EVENTS, type LatLng, type OfferClosedPayload } from "@rida/shared";
import { getEligibleRides, getRideSocket, useAuth, type EligibleRideItem } from "@rida/mobile-shared";

export const eligibleRidesQueryKey = ["eligibleRides"] as const;

/**
 * The requests this driver can claim right now (/driver/rides/eligible) —
 * the Home list AND the offer pop-ups, one cache entry so they always agree.
 *
 * - Polled every 10 s, refetched the moment a new request is broadcast and
 *   when the app comes back to the foreground (the focus manager).
 * - A request another driver took, the rider cancelled, or that expired
 *   (`ride:offer_closed`) leaves the list at once, before the refetch.
 * - Sends the driver's position so each offer says how far its pickup is;
 *   a new position alone doesn't refetch.
 */
export function useRequestsNearYou(enabled: boolean, position: LatLng | null = null) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const active = isAuthenticated && enabled;
  const positionRef = useRef(position);
  positionRef.current = position;

  const query = useQuery({
    queryKey: eligibleRidesQueryKey,
    queryFn: () => getEligibleRides(positionRef.current),
    enabled: active,
    refetchInterval: 10_000,
  });

  const { refetch } = query;
  useEffect(() => {
    if (!active) return;
    const socket = getRideSocket();
    const onBroadcast = () => void refetch();
    const onClosed = (payload: OfferClosedPayload) => {
      queryClient.setQueryData<EligibleRideItem[]>(eligibleRidesQueryKey, (rides) =>
        rides?.filter((r) => r.rideId !== payload.rideId),
      );
    };
    socket.on(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
    socket.on(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    return () => {
      socket.off(DRIVER_EVENTS.RIDE_BROADCAST, onBroadcast);
      socket.off(DRIVER_EVENTS.OFFER_CLOSED, onClosed);
    };
  }, [active, refetch, queryClient]);

  return query;
}
