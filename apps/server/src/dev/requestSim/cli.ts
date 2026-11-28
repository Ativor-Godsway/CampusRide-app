/**
 * `npm run simulate:requests` — fills the drivers' request board on the
 * phase2-test branch (TESTING-PHASE2.md): fake riders (the simulator's
 * reserved +233099… numbers, "Ama (test)"…) ask for rides at real campus
 * places through the LOCAL server, spread over a few minutes, so the board,
 * the pop-ups and the fares behave as with real riders. Nothing is ever
 * texted or pushed (the server runs with SMS and push off).
 *
 *   npm run simulate:requests --workspace apps/server
 *   npm run simulate:requests --workspace apps/server -- --count 12 --minutes 4 --shared 0.75 --open-now
 *
 * --open-now: opens CampusRide on the test copy (a manual "Open now", and the
 * "no drivers online" block off), for testing outside service hours.
 * Clean up with `npm run simulate:requests:cleanup`.
 */
import { SIM_ON_STAGING } from "./env"; // MUST stay first: loads .env.phase2-test (or, --staging, .env.staging) and refuses anything else.
import { PrismaClient } from "@prisma/client";
import { DEFAULT_WEEKLY_SCHEDULE, formatCedis } from "@rida/shared";
import { assertLocalApiUrl } from "../../db/devDbGuard";
import { dbHostFromUrl } from "../../db/dbHostGuard";
import { signAccessToken } from "../../services/auth/tokens";
import { ensureSimRiders, MAX_SIM_RIDERS } from "../sim/simAccounts";
import { SIM_SPOTS, planRequests, spotKey, type SpotKey } from "./plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string, fallback: number) => {
  const v = Number(arg(name));
  return Number.isFinite(v) && arg(name) !== undefined ? v : fallback;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const count = Math.min(MAX_SIM_RIDERS, Math.max(1, Math.round(num("count", 12))));
  const minutes = Math.max(0, num("minutes", 4));
  const sharedRatio = Math.min(1, Math.max(0, num("shared", 0.75)));
  // Staging: the deployed staging server (STAGING_API_URL) and nothing else.
  const server = SIM_ON_STAGING ? process.env.STAGING_API_URL! : (arg("server") ?? `http://localhost:${process.env.PORT ?? 3000}`);
  if (!SIM_ON_STAGING) assertLocalApiUrl(server, "simulate:requests");

  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nCampusRide request simulator  (${SIM_ON_STAGING ? "STAGING" : "phase2-test only"})`);
    console.log(`  database: ${dbHostFromUrl(process.env.DATABASE_URL ?? "")}`);
    console.log(`  server:   ${server}`);
    // A sleeping free staging server takes up to a minute to wake.
    let health = await fetch(`${server}/health`).catch(() => null);
    for (let i = 0; SIM_ON_STAGING && !health?.ok && i < 12; i++) {
      if (i === 0) console.log("  waking the staging server (free plan: up to a minute)…");
      await sleep(5_000);
      health = await fetch(`${server}/health`).catch(() => null);
    }
    if (!health?.ok) {
      throw new Error(
        SIM_ON_STAGING
          ? `The staging server isn't answering at ${server}. Check it on Render (STAGING.md).`
          : `The local server isn't answering at ${server}. Start it first (npm run dev:phase2 --workspace apps/server).`,
      );
    }

    if (process.argv.includes("--open-now")) {
      const data = { overrideMode: "OPEN" as const, overrideUntil: null, blockWhenNoDrivers: false };
      await prisma.serviceHoursSetting.upsert({
        where: { id: "service" },
        create: { id: "service", weekly: DEFAULT_WEEKLY_SCHEDULE as unknown as object, ...data },
        update: data,
      });
      console.log(`  CampusRide opened on ${SIM_ON_STAGING ? "staging" : "the test copy"} (Open now; no-drivers block off). Takes up to a minute to show.`);
    }

    // The real places for each spot (first active match by name).
    const places = new Map<SpotKey, { id: string; name: string }>();
    for (const spot of SIM_SPOTS) {
      for (const pattern of spot.patterns) {
        const p = await prisma.place.findFirst({ where: { isActive: true, name: { contains: pattern, mode: "insensitive" } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
        if (p) {
          places.set(spot.key, p);
          break;
        }
      }
      if (!places.has(spot.key)) console.log(`  ! no place found for ${spot.label}: left out`);
    }
    const spots = [...places.keys()];
    const from = spotKey(arg("from"));
    const to = spotKey(arg("to"));
    if ((arg("from") && !from) || (arg("to") && !to) || Boolean(from) !== Boolean(to)) {
      throw new Error(`--from and --to go together, each one of: ${SIM_SPOTS.map((s) => s.key).join(", ")}`);
    }
    if (from && to && (!places.has(from) || !places.has(to))) throw new Error("That spot has no place on this database.");
    const plan = planRequests({ count, minutes, sharedRatio, seed: Date.now() % 100_000, spots, route: from && to ? { pickup: from, dropoff: to } : null });
    const riders = await ensureSimRiders(prisma, count);
    console.log(`  ${count} requests over ${minutes} min · ${Math.round(sharedRatio * 100)}% Shared · at ${spots.map((s) => places.get(s)!.name).join(", ")}\n`);

    const start = Date.now();
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!;
      const rider = riders[i]!;
      const wait = start + p.atMs - Date.now();
      if (wait > 0) await sleep(wait);
      const headers = { "content-type": "application/json", authorization: `Bearer ${signAccessToken({ userId: rider.id, role: "RIDER" })}` };
      const pickup = { placeId: places.get(p.pickup)!.id };
      const dropoff = { placeId: places.get(p.dropoff)!.id };
      const label = `${places.get(p.pickup)!.name} → ${places.get(p.dropoff)!.name}`;
      const q = await fetch(`${server}/rides/quote`, { method: "POST", headers, body: JSON.stringify({ pickup, dropoff }) });
      const quote = q.ok ? ((await q.json()) as { fares: Record<"SHARED" | "LONE", number> }) : null;
      const res = await fetch(`${server}/rides`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: p.type, pickup, dropoff, paymentMethod: "CASH", ...(quote ? { shownFarePesewas: quote.fares[p.type] } : {}) }),
      });
      const clock = new Date().toLocaleTimeString("en-GB");
      const kind = p.type === "SHARED" ? "Shared    " : "Ride alone";
      if (res.status === 201) {
        console.log(`  ${clock}  ✓ ${rider.name.padEnd(14)} ${kind} ${quote ? formatCedis(quote.fares[p.type]).padEnd(6) : "      "} ${label}`);
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        console.log(`  ${clock}  ✗ ${rider.name.padEnd(14)} ${kind} ${label} — ${res.status} ${body.code ?? ""} ${body.error ?? ""}`);
      }
    }
    console.log(
      `\nDone. Requests search for 7 minutes, then show "no driver found". Clean up: ${SIM_ON_STAGING ? "npm run staging:fake-requests:cleanup" : "npm run simulate:requests:cleanup --workspace apps/server"}\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
