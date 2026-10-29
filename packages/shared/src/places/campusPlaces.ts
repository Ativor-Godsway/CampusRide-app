/**
 * Campus places — named spots a rider can search for and pick ("Balme
 * Library", "Night Market") — and the labels a pin gets from them. Pure, so
 * the server and both apps search and label exactly the same way.
 *
 * Place data comes from OpenStreetMap; wherever places are shown, show
 * PLACES_ATTRIBUTION.
 */
import { haversineDistanceMeters } from "../geo/distance";

export const PLACE_CATEGORIES = ["HALL", "HOSTEL", "FACULTY", "GATE", "FOOD", "LANDMARK", "OTHER"] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export const PLACE_CATEGORY_LABELS: Record<PlaceCategory, string> = {
  HALL: "Hall",
  HOSTEL: "Hostel",
  FACULTY: "Faculty",
  GATE: "Gate",
  FOOD: "Food",
  LANDMARK: "Landmark",
  OTHER: "Other",
};

/** The credit OpenStreetMap's licence (ODbL) asks for wherever its data is shown. */
export const PLACES_ATTRIBUTION = "© OpenStreetMap contributors";

export interface CampusPlace {
  id: string;
  name: string;
  aliases: readonly string[];
  latitude: number;
  longitude: number;
  category: PlaceCategory;
  zoneId: string;
  /** Something riders must know about the spot ("Cars can't pass the main gate"); servers before 2026-10-29 don't send it. */
  note?: string | null;
}

// ─── Labels for a pin ────────────────────────────────────────────────────────

/** A pin this close to a place is AT it: labelled with its name alone. */
export const AT_PLACE_METERS = 50;
/** Within this, a pin is "Near <place>". */
export const NEAR_PLACE_METERS = 250;
/** A pin with no place within NEAR_PLACE_METERS. */
export const PINNED_LOCATION_LABEL = "Pinned location";

/** The nearest place to a point and how far it is, or null with no places. */
export function nearestPlace<T extends Pick<CampusPlace, "latitude" | "longitude">>(
  point: { latitude: number; longitude: number },
  places: readonly T[],
): { place: T; meters: number } | null {
  let best: { place: T; meters: number } | null = null;
  for (const place of places) {
    const meters = haversineDistanceMeters(point, place);
    if (!best || meters < best.meters) best = { place, meters };
  }
  return best;
}

/** "Balme Library" (at it), "Near Balme Library", or "Pinned location". */
export function labelForPoint(
  point: { latitude: number; longitude: number },
  places: readonly Pick<CampusPlace, "name" | "latitude" | "longitude">[],
): string {
  const near = nearestPlace(point, places);
  if (!near || near.meters > NEAR_PLACE_METERS) return PINNED_LOCATION_LABEL;
  return near.meters <= AT_PLACE_METERS ? near.place.name : `Near ${near.place.name}`;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/** Lower case, accents and punctuation gone, single spaces: "Volta Café, (VH)" → "volta cafe vh". */
export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Edit distance with adjacent swaps (optimal string alignment), stopping early past `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0]!.push(j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2]![j - 2]! + 1);
      rows[i]!.push(d);
    }
    if (i > 0 && Math.min(...rows[i]!) > max) return max + 1;
  }
  return rows[a.length]![b.length]!;
}

/** Typos allowed in a word of this length: none for short words, then 1, then 2. */
function typoBudget(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/**
 * How well one query word matches a name's words: 3 whole word, 2 start of a
 * word, 1 within a typo budget of a word (or of its start), 0 no match.
 */
function wordScore(queryWord: string, words: readonly string[]): number {
  let best = 0;
  const budget = typoBudget(queryWord.length);
  for (const w of words) {
    if (w === queryWord) return 3;
    if (w.startsWith(queryWord)) best = Math.max(best, 2);
    else if (budget > 0) {
      const whole = editDistance(queryWord, w, budget) <= budget;
      const prefix = w.length > queryWord.length && editDistance(queryWord, w.slice(0, queryWord.length), budget) <= budget;
      if (whole || prefix) best = Math.max(best, 1);
    }
  }
  return best;
}

/**
 * 0 for no match; higher is better. Every query word must match one of the
 * place's names (its name or an alias), with or without a small typo, so
 * "balm lib", "nite market" and "commonweath" all find what they mean. A
 * name that starts with the whole query ranks above one that merely
 * contains it.
 */
export function placeMatchScore(place: Pick<CampusPlace, "name" | "aliases">, query: string): number {
  const q = normalizeSearchText(query);
  if (!q) return 0;
  const queryWords = q.split(" ");
  let best = 0;
  for (const candidate of [place.name, ...place.aliases]) {
    const text = normalizeSearchText(candidate);
    if (!text) continue;
    const words = text.split(" ");
    // The alias "ugbs" should match the query "u g b s" and vice versa.
    const joined = words.join("");
    let score: number;
    if (text === q || joined === queryWords.join("")) score = 100;
    else if (text.startsWith(q)) score = 80;
    else {
      const perWord = queryWords.map((qw) => wordScore(qw, words));
      if (perWord.some((s) => s === 0)) continue;
      score = 20 + perWord.reduce((sum, s) => sum + s, 0) * (10 / queryWords.length) * 1.5;
    }
    // A match on the real name beats the same match on an alias.
    if (candidate === place.name) score += 1;
    best = Math.max(best, score);
  }
  return best;
}

/** Places matching `query`, best first (ties: shorter name, then A–Z). Empty query → []. */
export function searchPlaces<T extends Pick<CampusPlace, "name" | "aliases">>(
  places: readonly T[],
  query: string,
  limit = 8,
): T[] {
  if (!normalizeSearchText(query)) return [];
  return places
    .map((place) => ({ place, score: placeMatchScore(place, query) }))
    .filter((r) => r.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.place.name.length - b.place.name.length ||
        a.place.name.localeCompare(b.place.name),
    )
    .slice(0, limit)
    .map((r) => r.place);
}
