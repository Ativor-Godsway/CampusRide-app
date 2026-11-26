import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  RIDE_EVENTS,
  SEARCH_STATUS_POLL_MS,
  parseRideSearchStatus,
  searchStatusPath,
  type RideSearchStatus,
} from "@rida/shared";
import { api } from "../auth/apiClient";
import { getRideSocket } from "../realtime/socket";

/**
 * What the search for this ride is doing (GET /rides/:id/search-status;
 * @rida/shared rides/searchStatus). Null once the ride isn't searching, or
 * from a server too old to say.
 */
export async function getRideSearchStatus(rideId: string): Promise<RideSearchStatus | null> {
  const res = await api.get<{ status?: unknown }>(searchStatusPath(rideId));
  return parseRideSearchStatus(res.data?.status);
}

/**
 * The search status for the rider's "Finding your driver" screen while
 * `enabled` (the ride is searching): asked at once, then every
 * SEARCH_STATUS_POLL_MS while the app is in front, and taken from
 * `ride:search_status` on the socket the moment dispatch acts. A failed ask
 * keeps what was shown; turning off clears it, so a new search never shows
 * the last one's numbers.
 */
export function useRideSearchStatus(rideId: string | undefined, enabled: boolean): RideSearchStatus | null {
  const [status, setStatus] = useState<RideSearchStatus | null>(null);
  const [foreground, setForeground] = useState(AppState.currentState !== "background");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setForeground(state !== "background"));
    return () => sub.remove();
  }, []);

  const on = enabled && !!rideId;
  const live = useRef({ rideId, on });
  live.current = { rideId, on };

  useEffect(() => {
    if (!on || !rideId) {
      setStatus(null);
      return;
    }
    const socket = getRideSocket();
    const onPush = (payload: unknown) => {
      const next = parseRideSearchStatus(payload);
      if (next && next.rideId === live.current.rideId && live.current.on) setStatus(next);
    };
    socket.on(RIDE_EVENTS.SEARCH_STATUS, onPush);
    return () => {
      socket.off(RIDE_EVENTS.SEARCH_STATUS, onPush);
    };
  }, [on, rideId]);

  useEffect(() => {
    if (!on || !rideId || !foreground) return;
    let cancelled = false;
    const load = () =>
      void getRideSearchStatus(rideId).then(
        (next) => {
          // Null = no longer searching: the ride screen moves on by itself.
          if (!cancelled && next) setStatus(next);
        },
        () => {},
      );
    load();
    const timer = setInterval(load, SEARCH_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [on, rideId, foreground]);

  // Another ride (followed a rebooking): never the old one's numbers.
  return status && status.rideId === rideId ? status : null;
}
