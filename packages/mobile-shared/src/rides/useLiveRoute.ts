import { useEffect, useMemo, useRef, useState } from "react";
import {
  decodePolyline,
  pathLengthMeters,
  pointsKey,
  shouldReroute,
  trimPathToPosition,
  type LatLng,
} from "@rida/shared";
import { getRoadRoute } from "./api";

export interface LiveRoute {
  /** The road still ahead: from `from` (when given) through every stop. Null until there is a road. */
  path: LatLng[] | null;
  /** Seconds to the first stop on what's left of the road, or null without one. */
  secondsToFirstStop: number | null;
  /** "osrm" (real roads) or "zones" (approximate). */
  source: "osrm" | "zones" | null;
  attribution: string | null;
}

interface Fetched {
  key: string;
  full: LatLng[];
  legs: { distanceMeters: number; durationSeconds: number }[];
  source: "osrm" | "zones";
  attribution: string;
}

/**
 * The road from a moving point (the driver) through some stops, for a map.
 *
 * Asked of the server once for each set of stops (POST /routes/legs; the
 * server caches and rate-limits OSRM), then trimmed to `from` as it moves.
 * A new road is asked for only when the stops change, or when `from` has
 * left the drawn road — and then not more than every 30 s
 * (shouldReroute) — so a trip costs a handful of requests, not one per GPS
 * fix. Until the first answer (or if it fails) `path` is null and the
 * caller draws its instant fallback.
 */
export function useLiveRoute(input: { from: LatLng | null; stops: readonly LatLng[]; enabled: boolean }): LiveRoute {
  const { from, stops, enabled } = input;
  const stopsKey = pointsKey(stops);
  const [route, setRoute] = useState<Fetched | null>(null);
  const lastAskedAt = useRef<number | null>(null);
  const routedFor = useRef<string | null>(null);
  const inFlight = useRef(false);
  const fromRef = useRef(from);
  fromRef.current = from;
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  useEffect(() => {
    if (!enabled || inFlight.current) return;
    const points = from ? [from, ...stops] : [...stops];
    if (points.length < 2 || points.length > 10) return;
    const current = route && route.key === stopsKey ? route : null;
    const ask = shouldReroute({
      hasRoute: current !== null,
      routedFor: routedFor.current,
      stopsKey,
      position: from,
      path: current?.full ?? [],
      lastAskedAt: lastAskedAt.current,
      now: Date.now(),
    });
    if (!ask) return;
    inFlight.current = true;
    lastAskedAt.current = Date.now();
    routedFor.current = stopsKey;
    getRoadRoute(points)
      .then((r) => {
        const full = decodePolyline(r.polyline);
        if (full.length < 2) return;
        // A route asked from the driver's position: its first leg starts there.
        setRoute({ key: stopsKey, full, legs: r.legs, source: r.source, attribution: r.attribution });
      })
      .catch(() => {
        // Keep whatever was drawn; shouldReroute tries again later.
      })
      .finally(() => {
        inFlight.current = false;
      });
    // `from` is in the deps so a car that leaves the road is re-routed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, stopsKey, from?.latitude, from?.longitude, route]);

  return useMemo<LiveRoute>(() => {
    if (!enabled || !route || route.key !== stopsKey) {
      return { path: null, secondsToFirstStop: null, source: null, attribution: null };
    }
    const path = from ? trimPathToPosition(route.full, from) : route.full;
    const first = route.legs[0];
    let secondsToFirstStop: number | null = null;
    if (first && first.distanceMeters > 0) {
      const travelled = Math.max(0, pathLengthMeters(route.full) - pathLengthMeters(path));
      const left = Math.max(0, first.distanceMeters - travelled);
      secondsToFirstStop = first.durationSeconds * (left / first.distanceMeters);
    } else if (first) {
      secondsToFirstStop = first.durationSeconds;
    }
    return { path, secondsToFirstStop, source: route.source, attribution: route.attribution };
  }, [enabled, route, stopsKey, from]);
}
