/**
 * `npm run staging:fake-schedule` — fake SCHEDULED bookings on staging so a
 * car reaches 3+, 2 and 1 seats (plan.ts) and every dispatch path can be
 * watched on the staging apps: offered at once, offered at 30 minutes, a
 * live request at 20 minutes, and live requests when no driver accepts by 25.
 *
 * Books through the deployed STAGING server's own API as the simulator's
 * fake riders (+233099… "(test)"), so the server does the grouping and the
 * pop-ups. Staging only: the guard refuses any other database, production
 * above all. Options: --from-minutes 40 (earliest slot), --to "Balme" (the
 * drop-off place), --open-now (open CampusRide on staging first).
 * Clean up: npm run staging:fake-schedule:cleanup.
 */
import { SIM_ON_STAGING } from "../requestSim/env"; // MUST stay first: loads .env.staging (with --staging) and refuses anything else.
import { PrismaClient } from "@prisma/client";
import { DEFAULT_WEEKLY_SCHEDULE, formatCedis, scheduleWhen, type ScheduleOptions } from "@rida/shared";
import { dbHostFromUrl } from "../../db/dbHostGuard";
import { signAccessToken } from "../../services/auth/tokens";
import { ensureSimRiders } from "../sim/simAccounts";
import { SIM_SPOTS } from "../requestSim/plan";
import { planFakeSchedule } from "./plan";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!SIM_ON_STAGING) throw new Error("staging:fake-schedule runs on staging only (npm run staging:fake-schedule).");
  const server = process.env.STAGING_API_URL!;
  const fromMinutes = Math.max(21, Number(arg("from-minutes") ?? 40) || 40);
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nCampusRide fake scheduled rides  (STAGING: ${dbHostFromUrl(process.env.DATABASE_URL ?? "")})`);
    let health: Response | null = null;
    for (let i = 0; !health?.ok && i < 12; i++) {
      if (i === 0) console.log("  waking the staging server (free plan: up to a minute)…");
      health = await fetch(`${server}/health`).catch(() => null);
      if (!health?.ok) await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!health?.ok) throw new Error(`The staging server isn't answering at ${server}. Check it on Render (STAGING.md).`);

    if (process.argv.includes("--open-now")) {
      const data = { overrideMode: "OPEN" as const, overrideUntil: null, blockWhenNoDrivers: false };
      await prisma.serviceHoursSetting.upsert({ where: { id: "service" }, create: { id: "service", weekly: DEFAULT_WEEKLY_SCHEDULE as unknown as object, ...data }, update: data });
      console.log("  CampusRide opened on staging (Open now). Takes up to a minute to show.");
    }

    // One pickup spot per car (riders in a car share it), one drop-off for all.
    const findPlace = (pattern: string) =>
      prisma.place.findFirst({ where: { isActive: true, name: { contains: pattern, mode: "insensitive" } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
    const dropoff = await findPlace(arg("to") ?? "Balme");
    if (!dropoff) throw new Error(`No active place matches the drop-off "${arg("to") ?? "Balme"}".`);
    const pickups = [];
    for (const spot of SIM_SPOTS) {
      if (spot.key === "balme") continue;
      const p = await findPlace(spot.patterns[0]!);
      if (p) pickups.push(p);
    }
    if (pickups.length === 0) throw new Error("No pickup places found on staging.");

    const riders = await ensureSimRiders(prisma, 6);
    const already = await prisma.scheduledBooking.count({ where: { riderId: { in: riders.map((r) => r.id) }, status: "BOOKED" } });
    if (already > 0) throw new Error("The fake riders already have scheduled rides. Run npm run staging:fake-schedule:cleanup first.");
    const headers = (userId: string) => ({ "content-type": "application/json", authorization: `Bearer ${signAccessToken({ userId, role: "RIDER" })}` });

    const optionsRes = await fetch(`${server}/rides/scheduled/options`, {
      method: "POST",
      headers: headers(riders[0]!.id),
      body: JSON.stringify({ pickup: { placeId: pickups[0]!.id }, dropoff: { placeId: dropoff.id }, seats: 1 }),
    });
    if (!optionsRes.ok) throw new Error(`The staging server refused the schedule options (${optionsRes.status}). Is the scheduled-rides branch deployed? (STAGING.md)`);
    const options = (await optionsRes.json()) as ScheduleOptions;
    const plan = planFakeSchedule(options.days.flatMap((d) => d.slots), Date.parse(options.serverTime), fromMinutes);
    if (plan.length === 0) throw new Error("No bookable slots far enough ahead. Try --open-now, or later in the day.");

    let next = 0;
    for (const [i, car] of plan.entries()) {
      const pickup = pickups[i % pickups.length]!;
      console.log(`\n  ${scheduleWhen(Date.parse(car.arriveBy), Date.now())}: ${car.riders} rider(s), ${pickup.name} → ${dropoff.name}`);
      for (let r = 0; r < car.riders; r++) {
        const rider = riders[next++]!;
        const res = await fetch(`${server}/rides/scheduled`, {
          method: "POST",
          headers: headers(rider.id),
          body: JSON.stringify({ arriveBy: car.arriveBy, pickup: { placeId: pickup.id }, dropoff: { placeId: dropoff.id }, seats: 1, shownFarePesewas: options.sharedBySeats[0] }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        console.log(res.status === 201 ? `    ✓ ${rider.name} · ${formatCedis(options.sharedBySeats[0])}` : `    ✗ ${rider.name} — ${res.status} ${body.code ?? ""} ${body.error ?? ""}`);
      }
    }
    console.log(
      "\nWhat happens next: the 3-seat car is offered to online drivers now; the 2-seat car at 30 minutes before; the 1-seat car becomes a live request at 20 minutes before; any car no driver took by 25 minutes before becomes live requests.",
    );
    console.log("Clean up: npm run staging:fake-schedule:cleanup\n");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
