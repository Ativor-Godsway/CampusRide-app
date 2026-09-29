import type { Zone } from "../types/zone";

/**
 * Landmarks shown under "Popular on campus" before the rider types.
 *
 * Curated, not measured: the server keeps no per-zone popularity, and the
 * brief was not to change server behaviour. Names are matched against the
 * live zone list, so one that doesn't exist is simply skipped. Replace with
 * real ride counts once the API exposes them.
 */
export const POPULAR_ZONE_NAMES = [
  "Balme Library",
  "Main Gate",
  "Great Hall",
  "School of Business",
  "Accra Mall Junction",
  "Sports Stadium",
] as const;

/** Anything with a drop-off zone and a creation time — a ride summary. */
export interface RideWithDropoff {
  createdAt: string | Date;
  dropoffZone: Zone;
}

/**
 * The rider's recent destinations: drop-off zones of their rides, newest
 * first, each zone once (three rides to the same hall are one row).
 */
export function recentDestinations(rides: readonly RideWithDropoff[], limit = 3): Zone[] {
  const sorted = [...rides].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const seen = new Set<string>();
  const out: Zone[] = [];
  for (const ride of sorted) {
    if (!ride.dropoffZone || seen.has(ride.dropoffZone.id)) continue;
    seen.add(ride.dropoffZone.id);
    out.push(ride.dropoffZone);
    if (out.length === limit) break;
  }
  return out;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export interface PlaceSuggestions {
  /** The rider's own recent destinations (filtered by the query). */
  recent: Zone[];
  /**
   * With no query: "Popular on campus". With a query: every OTHER zone that
   * matches, so typing can reach any place, not only the popular few.
   */
  places: Zone[];
  /** True when there is a query and nothing at all matched it. */
  noMatch: boolean;
}

/**
 * What Plan your ride lists under the input card, filtered as the rider
 * types. A zone never appears twice, and `excludeZoneId` (the zone already
 * chosen for the OTHER end of the trip) is left out, since pickup and
 * drop-off can't be the same place.
 */
export function placeSuggestions(input: {
  zones: readonly Zone[];
  recent: readonly Zone[];
  query: string;
  excludeZoneId?: string | null;
  popularNames?: readonly string[];
  limit?: number;
}): PlaceSuggestions {
  const { zones, recent, excludeZoneId, popularNames = POPULAR_ZONE_NAMES, limit = 6 } = input;
  const query = normalize(input.query);
  const matches = (zone: Zone) =>
    zone.id !== excludeZoneId && (!query || normalize(zone.name).includes(query));

  const recentOut = recent.filter(matches);
  const taken = new Set(recentOut.map((z) => z.id));

  let places: Zone[];
  if (query) {
    places = zones
      .filter((zone) => matches(zone) && !taken.has(zone.id))
      .sort((a, b) => {
        // Names that START with the query first (typing "ba" puts Balme
        // Library above School of Business), then alphabetical.
        const aStarts = normalize(a.name).startsWith(query) ? 0 : 1;
        const bStarts = normalize(b.name).startsWith(query) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      });
  } else {
    const byName = new Map(zones.map((zone) => [normalize(zone.name), zone]));
    places = popularNames
      .map((name) => byName.get(normalize(name)))
      .filter((zone): zone is Zone => zone !== undefined && matches(zone) && !taken.has(zone.id));
  }

  return {
    recent: recentOut,
    places: places.slice(0, limit),
    noMatch: query !== "" && recentOut.length === 0 && places.length === 0,
  };
}
