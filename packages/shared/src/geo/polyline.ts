import { haversineDistanceMeters } from "./distance";

export interface PathPoint {
  latitude: number;
  longitude: number;
}

/**
 * Decodes a Google encoded polyline (the format OSRM and openrouteservice
 * return; precision 5 = 1e-5 degrees). Returns [] for an empty or malformed
 * string rather than throwing: a missing route falls back to a straight line.
 */
export function decodePolyline(encoded: string, precision = 5): PathPoint[] {
  const factor = 10 ** precision;
  const points: PathPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  const next = (): number | null => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) return null;
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) return null;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    const dLat = next();
    const dLng = next();
    if (dLat === null || dLng === null) return [];
    lat += dLat;
    lng += dLng;
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return points;
}

/** Encodes points as a Google polyline (precision 5). Used by tests and the precompute script's dry run. */
export function encodePolyline(points: readonly PathPoint[], precision = 5): string {
  const factor = 10 ** precision;
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  const put = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.latitude * factor);
    const lng = Math.round(p.longitude * factor);
    put(lat - prevLat);
    put(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

/** Total length of a path, in metres. */
export function pathLengthMeters(path: readonly PathPoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += haversineDistanceMeters(path[i - 1]!, path[i]!);
  return total;
}

/**
 * The point `meters` along `path` from its start (clamped to its ends).
 * Linear between vertices, which is plenty at campus scale. Drives the
 * dev-only fake location along a route.
 */
export function pointAlongPath(path: readonly PathPoint[], meters: number): PathPoint | null {
  if (path.length === 0) return null;
  if (meters <= 0 || path.length === 1) return { ...path[0]! };
  let remaining = meters;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const leg = haversineDistanceMeters(a, b);
    if (remaining <= leg) {
      const f = leg === 0 ? 0 : remaining / leg;
      return {
        latitude: a.latitude + (b.latitude - a.latitude) * f,
        longitude: a.longitude + (b.longitude - a.longitude) * f,
      };
    }
    remaining -= leg;
  }
  return { ...path[path.length - 1]! };
}
