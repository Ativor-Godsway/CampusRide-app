import { useEffect, useState } from "react";
import { RIDE_EVENTS, steadyArrivalAt, type RideEtaPayload } from "@rida/shared";
import { getRideSocket } from "../realtime/socket";

/** A server ETA older than this is no longer used (the driver's pings stopped). */
export const SERVER_ETA_FRESH_MS = 45_000;

/**
 * The server's road ETA for this rider (RIDE_EVENTS.ETA, to their own room,
 * every 10 s while the driver's position is relayed): seconds to their
 * pickup or drop-off, whichever `toward` asks for. Null until one arrives, or
 * once the last is SERVER_ETA_FRESH_MS old — the caller then uses its own
 * estimate. Servers from before it send none: the same.
 */
export function useServerEta(rideId: string | undefined, toward: RideEtaPayload["toward"] | null): number | null {
  const [latest, setLatest] = useState<RideEtaPayload | null>(null);

  useEffect(() => {
    setLatest(null);
    if (!rideId || !toward) return;
    const socket = getRideSocket();
    const handler = (payload: RideEtaPayload) => {
      if (payload.rideId !== rideId || payload.toward !== toward) return;
      if (!Number.isFinite(payload.seconds) || payload.seconds < 0) return;
      setLatest(payload);
    };
    socket.on(RIDE_EVENTS.ETA, handler);
    return () => {
      socket.off(RIDE_EVENTS.ETA, handler);
    };
  }, [rideId, toward]);

  // Forget it once stale.
  useEffect(() => {
    if (!latest) return;
    const timer = setTimeout(() => setLatest(null), SERVER_ETA_FRESH_MS);
    return () => clearTimeout(timer);
  }, [latest]);

  return latest ? latest.seconds : null;
}

/** How often the shown minutes are worked out again from the steady arrival time. */
const TICK_MS = 15_000;

export interface SteadyEta {
  /** Minutes from now to `arrivalAt` (not rounded; display rounds). */
  minutes: number;
  /** The arrival time shown (epoch ms). */
  arrivalAt: number;
}

/**
 * An ETA that doesn't flicker: each new estimate (`seconds` from now) moves
 * the shown arrival time only when it is a minute or more away from it
 * (steadyArrivalAt in @rida/shared), and the minutes count down from that
 * time as the clock moves. A missing estimate keeps what is shown; a new
 * `key` (another leg, another ride) starts afresh.
 */
export function useSteadyEta(seconds: number | null, key: string): SteadyEta | null {
  const [state, setState] = useState<{ key: string; arrivalAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (seconds === null || !Number.isFinite(seconds)) return;
    const estimate = Date.now() + seconds * 1000;
    setState((prev) => {
      const shown = prev && prev.key === key ? prev.arrivalAt : null;
      const arrivalAt = steadyArrivalAt(shown, estimate);
      return prev && prev.key === key && prev.arrivalAt === arrivalAt ? prev : { key, arrivalAt };
    });
    setNow(Date.now());
  }, [seconds, key]);

  const showing = state && state.key === key ? state.arrivalAt : null;
  useEffect(() => {
    if (showing === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [showing]);

  return showing === null ? null : { minutes: (showing - now) / 60_000, arrivalAt: showing };
}
