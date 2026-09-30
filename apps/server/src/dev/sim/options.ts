import { MAX_SIM_RIDERS } from "./simAccounts";

export interface SimOptions {
  /** Seconds between new requests. */
  intervalSec: number;
  /** Most unaccepted requests open at once. */
  maxOpen: number;
  /** Share of requests that are Shared (0–1); the rest are Ride alone. */
  sharedRatio: number;
  /** Share of riders who give up if nobody accepts within 20–60s (0–1). */
  cancelRatio: number;
  /** Force pickups into the zone whose name contains this text. */
  zone: string | null;
  /** Fire this many requests at once on start. */
  burst: number;
  /** How many fake riders to create/reuse. */
  riders: number;
  /** The LOCAL server the requests go to. */
  apiUrl: string;
  help: boolean;
}

export const SIM_USAGE = `
Fake-rider simulator — sends ride requests to your LOCAL server so you can test
the driver app with one phone. See docs/testing/SOLO_TESTING.md.

  npm run sim:riders -- [options]

  --interval <sec>      seconds between new requests            (default 20)
  --max-open <n>        most unaccepted requests at once        (default 4)
  --shared-ratio <0-1>  share of requests that are Shared       (default 0.7)
  --cancel-ratio <0-1>  share of riders who give up waiting     (default 0.15)
  --zone <name>         force pickups in this zone, e.g. --zone "Balme"
  --burst <n>           fire n requests at once on start, e.g. --burst 5
  --riders <n>          number of fake riders, max ${MAX_SIM_RIDERS}             (default 10)
  --api <url>           your local server                       (default http://localhost:3000)
  --help                show this help

Stop with Ctrl+C.
`;

export class SimOptionError extends Error {}

function num(flag: string, raw: string | undefined, min: number, max: number, integer: boolean): number {
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    throw new SimOptionError(`${flag} needs a ${integer ? "whole number" : "number"}, got "${raw ?? ""}"`);
  }
  if (value < min || value > max) {
    throw new SimOptionError(`${flag} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

/** Parses `--flag value` and `--flag=value`. Throws SimOptionError on anything unrecognised. */
export function parseSimOptions(argv: string[], env: NodeJS.ProcessEnv = {}): SimOptions {
  const opts: SimOptions = {
    intervalSec: 20,
    maxOpen: 4,
    sharedRatio: 0.7,
    cancelRatio: 0.15,
    zone: null,
    burst: 0,
    riders: 10,
    apiUrl: env.SIM_API_URL || `http://localhost:${env.PORT || 3000}`,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new SimOptionError(`Unexpected argument "${arg}"`);

    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);

    switch (flag) {
      case "--interval": opts.intervalSec = num(flag, value, 2, 3600, false); break;
      case "--max-open": opts.maxOpen = num(flag, value, 1, MAX_SIM_RIDERS, true); break;
      case "--shared-ratio": opts.sharedRatio = num(flag, value, 0, 1, false); break;
      case "--cancel-ratio": opts.cancelRatio = num(flag, value, 0, 1, false); break;
      case "--burst": opts.burst = num(flag, value, 1, MAX_SIM_RIDERS, true); break;
      case "--riders": opts.riders = num(flag, value, 2, MAX_SIM_RIDERS, true); break;
      case "--zone":
        if (!value?.trim()) throw new SimOptionError("--zone needs a zone name");
        opts.zone = value.trim();
        break;
      case "--api":
        if (!value?.trim()) throw new SimOptionError("--api needs a URL");
        opts.apiUrl = value.trim().replace(/\/+$/, "");
        break;
      default:
        throw new SimOptionError(`Unknown option "${flag}"`);
    }
  }

  if (opts.burst > opts.riders) {
    throw new SimOptionError(`--burst ${opts.burst} needs at least that many riders (--riders)`);
  }
  return opts;
}
