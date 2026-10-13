/**
 * The fake driver's choices, kept pure so they can be tested: options, which
 * request to accept, and the positions it reports while driving.
 */
import { pathLengthMeters, pointAlongPath, type PathPoint } from "@rida/shared";
import { SIM_PHONE_PREFIX } from "./simAccounts";

export class FakeDriverOptionError extends Error {}

export interface FakeDriverOptions {
  /** Driving speed, km/h. */
  speedKmh: number;
  /** Seconds to wait at the pickup before picking the rider up. */
  waitSec: number;
  /** Campus place to start from (name contains this text). */
  at: string;
  /** The LOCAL server. */
  apiUrl: string;
  help: boolean;
}

export const FAKE_DRIVER_USAGE = `
Fake driver — accepts YOUR newest ride request and drives it, so you can test
the RIDER app with one phone. Local server and dev database only.
See docs/testing/SOLO_TESTING.md.

  npm run sim:driver -- [options]

  --speed <km/h>   driving speed                          (default 30)
  --wait <sec>     wait at the pickup before picking up   (default 10)
  --at <place>     campus place to start from             (default "Main Gate")
  --api <url>      your local server                      (default http://localhost:3000)
  --help           show this help

Stop with Ctrl+C (the driver goes offline).
`;

function num(flag: string, raw: string | undefined, min: number, max: number): number {
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(value)) {
    throw new FakeDriverOptionError(`${flag} needs a number, got "${raw ?? ""}"`);
  }
  if (value < min || value > max) throw new FakeDriverOptionError(`${flag} must be between ${min} and ${max}, got ${value}`);
  return value;
}

export function parseFakeDriverOptions(argv: string[], env: NodeJS.ProcessEnv = {}): FakeDriverOptions {
  const opts: FakeDriverOptions = {
    speedKmh: 30,
    waitSec: 10,
    at: "Main Gate",
    apiUrl: env.SIM_API_URL || `http://localhost:${env.PORT || 3000}`,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new FakeDriverOptionError(`Unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    switch (flag) {
      case "--speed":
        opts.speedKmh = num(flag, value, 5, 120);
        break;
      case "--wait":
        opts.waitSec = num(flag, value, 0, 300);
        break;
      case "--at":
        if (!value?.trim()) throw new FakeDriverOptionError("--at needs a place name");
        opts.at = value.trim();
        break;
      case "--api":
        if (!value?.trim()) throw new FakeDriverOptionError("--api needs a URL");
        opts.apiUrl = value.trim().replace(/\/+$/, "");
        break;
      default:
        throw new FakeDriverOptionError(`Unknown option "${flag}"`);
    }
  }
  return opts;
}

/**
 * The request to accept: the newest one from a REAL rider (you), never one
 * of the fake riders from `sim:riders`.
 */
export function pickOwnRequest<T extends { createdAt: Date; riderPhone: string }>(requests: readonly T[]): T | null {
  return (
    [...requests]
      .filter((r) => !r.riderPhone.startsWith(SIM_PHONE_PREFIX))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null
  );
}

/**
 * Where the car is after each tick, driving `path` at `speedKmh`: one point
 * per `tickMs` (about once a second, like a phone's GPS), the last one
 * exactly at the end of the road.
 */
export function positionsAlong(path: readonly PathPoint[], speedKmh: number, tickMs = 1_000): PathPoint[] {
  if (path.length === 0) return [];
  const total = pathLengthMeters(path);
  const step = (speedKmh * 1000) / 3600 * (tickMs / 1000);
  const out: PathPoint[] = [];
  for (let travelled = step; travelled < total; travelled += step) out.push(pointAlongPath(path, travelled)!);
  out.push({ ...path[path.length - 1]! });
  return out;
}

/** "1.2 km" / "350 m". */
export function shortDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters / 10) * 10} m`;
}
