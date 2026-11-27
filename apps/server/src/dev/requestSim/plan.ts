/**
 * What the request simulator books (pure, so it can be tested): `count`
 * requests spread over `minutes`, picked up at the campus spots the board
 * should show — Pentagon, JQB, Jean Nelson, Bani, Balme, TF — each going to
 * another of them, mostly Shared. Deterministic for a given seed.
 */

export const SIM_SPOTS = [
  { key: "pentagon", label: "Pentagon", patterns: ["Pentagon Block A", "Pentagon"] },
  { key: "jqb", label: "JQB", patterns: ["James Quartey", "JQB"] },
  { key: "jean-nelson", label: "Jean Nelson", patterns: ["Jean Nelson Aka"] },
  { key: "bani", label: "Bani", patterns: ["Bani Hostel"] },
  { key: "balme", label: "Balme", patterns: ["Balme Library", "Balme"] },
  { key: "tf", label: "TF", patterns: ["James Topp Nelson Yankah", "TF Hall"] },
] as const;

export type SpotKey = (typeof SIM_SPOTS)[number]["key"];

export interface PlannedRequest {
  /** When to send it, ms after the start. */
  atMs: number;
  pickup: SpotKey;
  dropoff: SpotKey;
  type: "SHARED" | "LONE";
}

/** A small seeded random number generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A spot key from the command line (`--from pentagon`), or null. */
export function spotKey(value: string | undefined): SpotKey | null {
  return SIM_SPOTS.some((s) => s.key === value) ? (value as SpotKey) : null;
}

export function planRequests(opts: {
  count: number;
  minutes: number;
  sharedRatio: number;
  seed: number;
  spots?: readonly SpotKey[];
  /** Every request on one route (`--from` and `--to`): to test "fill moving cars first" on a car going that way. */
  route?: { pickup: SpotKey; dropoff: SpotKey } | null;
}): PlannedRequest[] {
  const spots = opts.spots ?? SIM_SPOTS.map((s) => s.key);
  if (spots.length < 2) throw new Error("Need at least two campus spots to plan trips.");
  const next = rng(opts.seed);
  const spanMs = Math.max(0, opts.minutes) * 60_000;
  const out: PlannedRequest[] = [];
  for (let i = 0; i < opts.count; i++) {
    // Pickups take turns over the spots, so every one gets requests (and the chips counts).
    const pickup = opts.route?.pickup ?? spots[i % spots.length]!;
    const others = spots.filter((s) => s !== pickup);
    const dropoff = opts.route?.dropoff ?? others[Math.floor(next() * others.length)]!;
    const atMs = opts.count <= 1 ? 0 : Math.round((spanMs * i) / (opts.count - 1));
    out.push({ atMs, pickup, dropoff, type: next() < opts.sharedRatio ? "SHARED" : "LONE" });
  }
  return out;
}
