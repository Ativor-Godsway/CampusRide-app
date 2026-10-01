/**
 * `npm run sim:riders` — fake riders requesting rides against your LOCAL
 * server, so the driver app can be tested with one phone. Step-by-step guide:
 * docs/testing/SOLO_TESTING.md.
 *
 * Requests go through the real HTTP route (POST /rides), exactly as the
 * rider app sends them, so broadcast, the requests list, dispatch timeouts
 * and pricing all behave for real. (Calling createRide in this process would
 * not do: the ride:broadcast socket event is emitted by the SERVER's
 * Socket.io instance, so the driver app would never hear about it.)
 * The database is only read, to follow what happens to each request.
 */
import "./simEnv"; // MUST stay first: loads .env.development and refuses production.
import { PrismaClient } from "@prisma/client";
import {
  RIDER_CANCEL_REASON_LABELS,
  formatCedis,
  getLoneFare,
  getSharedFarePerRider,
  type RideType,
  type RiderDecisionAction,
} from "@rida/shared";
import { signAccessToken } from "../../services/auth/tokens";
import { assertDevOnlyDatabase, assertLocalApiUrl } from "../../db/devDbGuard";
import { ensureSimRiders, SIM_PHONE_PREFIX, type SimRider } from "./simAccounts";
import { assertRiderSideRequest } from "./riderOnly";
import { parseSimOptions, SimOptionError, SIM_USAGE, type SimOptions } from "./options";
import {
  PAIR_CHANCE,
  pickDecision,
  pickDropoffZone,
  pickPickupZone,
  pickRideType,
  pickSearchingCancelReason,
  planGiveUp,
  type PlannerZone,
} from "./planner";

// ─── Output ────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  dim: paint("2"),
  bold: paint("1"),
  green: paint("32"),
  yellow: paint("33"),
  red: paint("31"),
  cyan: paint("36"),
  magenta: paint("35"),
};

function log(icon: string, message: string): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${c.dim(time)}  ${icon}  ${message}`);
}

const typeLabel = (t: RideType) => (t === "SHARED" ? "Shared" : "Ride alone");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rng = Math.random;

/** The dev mock driver (src/dev/mockDriver.ts). If it accepts, ENABLE_MOCK_DRIVER is on. */
const MOCK_DRIVER_PHONE = "+233000000001";

// ─── State ─────────────────────────────────────────────────────────────────

interface Track {
  rider: SimRider;
  /** The ride the rider is currently on — follows a merge into another car. */
  rideId: string;
  /** Their own request. */
  requestRideId: string;
  type: RideType;
  pickup: string;
  dropoff: string;
  rideStatus: string;
  legStatus: string | null;
  /** When they give up if still unaccepted (epoch ms), or null. */
  giveUpAt: number | null;
  /** A decision is already scheduled/sent for this AWAITING_RIDER_DECISION round. */
  deciding: boolean;
  everAccepted: boolean;
}

const stats = { requested: 0, accepted: 0, completed: 0, cancelledByRider: 0, expired: 0 };

class Fatal extends Error {}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let opts: SimOptions;
  try {
    opts = parseSimOptions(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof SimOptionError) {
      console.error(`\n${err.message}\n${SIM_USAGE}`);
      process.exit(1);
    }
    throw err;
  }
  if (opts.help) {
    console.log(SIM_USAGE);
    return;
  }
  assertLocalApiUrl(opts.apiUrl, "simulator");

  // simEnv already checked this; checked again right where the client is made.
  const databaseUrl = process.env.DATABASE_URL ?? "";
  assertDevOnlyDatabase(databaseUrl, "simulator");
  const prisma = new PrismaClient({ log: ["error"] });
  const sim = new Simulator(prisma, opts);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\nForced exit.");
      process.exit(130);
    }
    stopping = true;
    console.log(c.dim("\nStopping… (press Ctrl+C again to force)"));
    sim
      .stop()
      .catch((err) => console.error(err))
      .finally(() => prisma.$disconnect().finally(() => process.exit(0)));
  });

  try {
    await sim.start();
  } catch (err) {
    await prisma.$disconnect();
    if (err instanceof Fatal) {
      console.error(`\n${c.red("✗")} ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

class Simulator {
  private riders: SimRider[] = [];
  private zones: PlannerZone[] = [];
  private adjacency = new Map<string, Set<string>>();
  private tracks = new Map<string, Track>(); // by rider id
  private timers: NodeJS.Timeout[] = [];
  private lastDriverNote = "";
  private warnedMockDriver = false;
  private polling = false;
  /** A request tick is running; with a slow server, ticks would otherwise overlap and pick the same rider. */
  private requesting = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: SimOptions,
  ) {}

  async start(): Promise<void> {
    const host = new URL(process.env.DATABASE_URL!).hostname;
    console.log(c.bold("\nCampusRide fake-rider simulator") + c.dim("  (local / development only)"));
    console.log(c.dim(`  database: ${host}`));
    console.log(c.dim(`  server:   ${this.opts.apiUrl}`));
    console.log(
      c.dim(
        `  every ${this.opts.intervalSec}s · max ${this.opts.maxOpen} open · ` +
          `${Math.round(this.opts.sharedRatio * 100)}% Shared · ` +
          `${Math.round(this.opts.cancelRatio * 100)}% give up` +
          (this.opts.zone ? ` · pickups in "${this.opts.zone}"` : ""),
      ),
    );
    console.log(c.dim("  Ctrl+C to stop\n"));

    await this.checkServer();
    await this.loadZones();
    this.riders = await ensureSimRiders(this.prisma, this.opts.riders);
    log("👥", `${this.riders.length} fake riders ready (${this.riders.map((r) => r.name.slice(5)).join(", ")})`);
    await this.adoptExistingRides();

    this.timers.push(setInterval(() => void this.poll(), 2_000));
    this.timers.push(setInterval(() => void this.requestTick(), this.opts.intervalSec * 1000));

    if (this.opts.burst > 0) {
      log("💥", c.bold(`Burst: ${this.opts.burst} requests at once`));
      await this.requestTick(this.opts.burst);
    } else {
      await this.requestTick();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);

    // Withdraw requests nobody has accepted, so they don't linger in the
    // driver app. Accepted trips are left alone for you to finish.
    const open = [...this.tracks.values()].filter(
      (t) => t.rideStatus === "REQUESTED" || t.rideStatus === "AWAITING_RIDER_DECISION",
    );
    for (const t of open) {
      await this.api("POST", `/rides/${t.rideId}/cancel`, t.rider, { reason: "CHANGED_PLANS" }).catch(() => {});
    }
    const onTrip = this.tracks.size - open.length;

    console.log("");
    log("⏹", c.bold("Simulator stopped."));
    console.log(
      `   requested ${stats.requested} · accepted ${stats.accepted} · completed ${stats.completed} · ` +
        `gave up ${stats.cancelledByRider} · expired ${stats.expired}`,
    );
    if (open.length > 0) console.log(`   Withdrew ${open.length} request(s) nobody had accepted.`);
    if (onTrip > 0) console.log(`   ${onTrip} accepted trip(s) are still going — finish them in the driver app.`);
    console.log(c.dim("   Remove all fake riders and their trips with: npm run sim:cleanup\n"));
  }

  // ── Setup ───────────────────────────────────────────────────────────────

  private async checkServer(): Promise<void> {
    try {
      const res = await fetch(`${this.opts.apiUrl}/health`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      throw new Fatal(
        `Can't reach your local server at ${this.opts.apiUrl}.\n` +
          `  Start it first, in another terminal:  npm run dev:server\n` +
          `  (docs/testing/SOLO_TESTING.md, step 2)`,
      );
    }
  }

  private async loadZones(): Promise<void> {
    const [zones, edges] = await Promise.all([
      this.prisma.zone.findMany({ select: { id: true, name: true, latitude: true, longitude: true } }),
      this.prisma.zoneAdjacency.findMany({ select: { zoneId: true, adjacentZoneId: true } }),
    ]);
    if (zones.length < 2) {
      throw new Fatal("This database has no zones. Seed them first: npm run db:seed:dev --workspace apps/server");
    }
    this.zones = zones;
    for (const e of edges) {
      if (!this.adjacency.has(e.zoneId)) this.adjacency.set(e.zoneId, new Set());
      if (!this.adjacency.has(e.adjacentZoneId)) this.adjacency.set(e.adjacentZoneId, new Set());
      this.adjacency.get(e.zoneId)!.add(e.adjacentZoneId);
      this.adjacency.get(e.adjacentZoneId)!.add(e.zoneId);
    }
    if (this.opts.zone) this.forcedZone(); // fail fast on a typo
  }

  private forcedZone(): PlannerZone {
    const q = this.opts.zone!.toLowerCase();
    const matches = this.zones.filter((z) => z.name.toLowerCase().includes(q));
    if (matches.length === 0) {
      throw new Fatal(
        `No zone matches --zone "${this.opts.zone}". Zones are:\n  ` +
          this.zones.map((z) => z.name).sort().join("\n  "),
      );
    }
    return matches.find((z) => z.name.toLowerCase() === q) ?? matches[0]!;
  }

  /** Picks up rides left open by a previous run, so they are followed and counted. */
  private async adoptExistingRides(): Promise<void> {
    const ids = this.riders.map((r) => r.id);
    const rides = await this.prisma.ride.findMany({
      where: {
        riderId: { in: ids },
        status: { in: ["REQUESTED", "MATCHED", "ARRIVED", "IN_PROGRESS", "AWAITING_RIDER_DECISION"] },
      },
      include: { pickupZone: true, dropoffZone: true },
    });
    let adopted = 0;
    for (const ride of rides) {
      const rider = this.riders.find((r) => r.id === ride.riderId)!;
      const current = this.tracks.get(rider.id);
      if (current && current.rideId !== "") continue; // already following it
      adopted += 1;
      this.tracks.set(rider.id, {
        rider,
        rideId: ride.id,
        requestRideId: ride.id,
        type: ride.type,
        pickup: ride.pickupZone.name,
        dropoff: ride.dropoffZone.name,
        rideStatus: ride.status,
        legStatus: null,
        giveUpAt: null,
        deciding: false,
        everAccepted: ride.driverId !== null,
      });
    }
    if (adopted > 0) log("↺", c.dim(`Following ${adopted} ride(s) left over from an earlier run`));
  }

  // ── Requests ────────────────────────────────────────────────────────────

  private openCount(): number {
    return [...this.tracks.values()].filter(
      (t) => t.rideStatus === "REQUESTED" || t.rideStatus === "AWAITING_RIDER_DECISION",
    ).length;
  }

  private freeRiders(): SimRider[] {
    return this.riders.filter((r) => !this.tracks.has(r.id));
  }

  /** The online driver the requests are aimed at: a real (non-test) account with a zone. */
  private async findDriverZone(): Promise<PlannerZone | null> {
    const driver = await this.prisma.driver.findFirst({
      where: {
        isOnline: true,
        isApproved: true,
        currentZoneId: { not: null },
        NOT: { user: { phone: { startsWith: "+2330" } } },
      },
      orderBy: { updatedAt: "desc" },
      include: { currentZone: true, user: { select: { name: true } } },
    });
    const note = driver ? `${driver.user.name}@${driver.currentZone!.name}` : "none";
    if (note !== this.lastDriverNote) {
      this.lastDriverNote = note;
      if (driver) {
        log("🚗", c.cyan(`${driver.user.name} is online in ${driver.currentZone!.name}`) +
          c.dim(" — requests will come from there and nearby"));
      } else if (!this.opts.zone) {
        log("⏳", c.yellow("Waiting for a driver to go online… open the driver app and tap Go online."));
      }
    }
    return driver?.currentZone ?? null;
  }

  private async requestTick(count = 1): Promise<void> {
    if (this.stopped || this.requesting) return;
    this.requesting = true;
    try {
      let pickupBase: PlannerZone | null;
      if (this.opts.zone) {
        pickupBase = this.forcedZone();
        await this.findDriverZone(); // still report the driver
      } else {
        pickupBase = await this.findDriverZone();
      }
      if (!pickupBase) return;

      const limit = count > 1 ? Math.max(this.opts.maxOpen, count) : this.opts.maxOpen;
      for (let i = 0; i < count; i++) {
        if (this.openCount() >= limit) {
          if (count === 1) log("·", c.dim(`${this.openCount()} requests already open — waiting for one to clear`));
          return;
        }
        const rider = this.freeRiders()[0];
        if (!rider) {
          if (count === 1) log("·", c.dim("Every fake rider is busy — waiting for one to finish"));
          return;
        }
        const pickup = this.opts.zone
          ? pickupBase
          : pickPickupZone(pickupBase, this.adjacentZones(pickupBase), rng);
        const dropoff = pickDropoffZone(this.zones, pickup, rng);
        const type = pickRideType(this.opts.sharedRatio, rng);
        const ok = await this.request(rider, pickup, dropoff, type);

        // Sometimes a second rider going the same way, to test filling a car.
        if (
          ok && count === 1 && type === "SHARED" && rng() < PAIR_CHANCE &&
          this.openCount() < this.opts.maxOpen
        ) {
          const buddy = this.freeRiders()[0];
          if (buddy) {
            this.tracks.set(buddy.id, placeholder(buddy)); // reserve while waiting
            await sleep(3_000 + Math.floor(rng() * 5_000));
            this.tracks.delete(buddy.id);
            if (!this.stopped) {
              await this.request(buddy, pickup, dropoff, "SHARED", rider.name);
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Fatal) {
        console.error(`\n${c.red("✗")} ${err.message}\n`);
        process.kill(process.pid, "SIGINT");
        return;
      }
      log("!", c.red(`Request failed: ${(err as Error).message}`));
    } finally {
      this.requesting = false;
    }
  }

  private adjacentZones(zone: PlannerZone): PlannerZone[] {
    const ids = this.adjacency.get(zone.id) ?? new Set<string>();
    return this.zones.filter((z) => ids.has(z.id));
  }

  private async request(
    rider: SimRider,
    pickup: PlannerZone,
    dropoff: PlannerZone,
    type: RideType,
    sameWayAs?: string,
  ): Promise<boolean> {
    const res = await this.api("POST", "/rides", rider, {
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      type,
      paymentMethod: "CASH",
    });

    if (res.status === 409 && res.body?.code === "ACTIVE_RIDE_EXISTS") {
      log("·", c.dim(`${rider.name} already has a ride going — skipping`));
      await this.adoptExistingRides();
      return false;
    }
    if (res.status === 429) {
      log("!", c.yellow("The server is rate-limiting the simulator. Restart it with npm run dev:server " +
        "(development servers don't rate-limit this Mac)."));
      return false;
    }
    if (res.status !== 201) {
      log("!", c.red(`${rider.name}'s request was refused: HTTP ${res.status} ${JSON.stringify(res.body)}`));
      return false;
    }

    const rideId: string = res.body.ride.id;
    // The server and this simulator must share a database, or nothing below means anything.
    const exists = await this.prisma.ride.findUnique({ where: { id: rideId }, select: { id: true } });
    if (!exists) {
      throw new Fatal(
        `The server at ${this.opts.apiUrl} accepted the request, but the ride is not in the ` +
          `database this simulator reads. The server is running against a different database.\n` +
          `  Restart it with:  npm run dev:server   (it reads apps/server/.env.development)`,
      );
    }

    stats.requested++;
    const giveUp = planGiveUp(this.opts.cancelRatio, rng);
    this.tracks.set(rider.id, {
      rider,
      rideId,
      requestRideId: rideId,
      type,
      pickup: pickup.name,
      dropoff: dropoff.name,
      rideStatus: "REQUESTED",
      legStatus: "WAITING",
      giveUpAt: giveUp === null ? null : Date.now() + giveUp,
      deciding: false,
      everAccepted: false,
    });

    const fare = type === "LONE" ? getLoneFare() : getSharedFarePerRider(1);
    log(
      "📍",
      `${c.bold(rider.name)} requested ${c.magenta(typeLabel(type))} (${formatCedis(fare)}), ` +
        `${pickup.name} → ${dropoff.name}` +
        (sameWayAs ? c.dim(`  — going the same way as ${sameWayAs}`) : ""),
    );
    return true;
  }

  // ── Following rides ─────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const tracks = [...this.tracks.values()].filter((t) => t.rideId !== "");
      if (tracks.length === 0) return;
      const riderIds = tracks.map((t) => t.rider.id);
      const rides = await this.prisma.ride.findMany({
        where: { id: { in: tracks.map((t) => t.rideId) } },
        include: {
          passengers: { where: { riderId: { in: riderIds } } },
          driver: { select: { name: true, phone: true } },
          rider: { select: { name: true } },
        },
      });
      const byId = new Map(rides.map((r) => [r.id, r]));

      for (const t of tracks) {
        const ride = byId.get(t.rideId);
        if (!ride) {
          log("·", c.dim(`${t.rider.name}'s ride no longer exists (cleaned up?) — dropping it`));
          this.tracks.delete(t.rider.id);
          continue;
        }
        await this.observe(t, ride);
      }
    } catch (err) {
      log("!", c.red(`Couldn't check rides: ${(err as Error).message}`));
    } finally {
      this.polling = false;
    }
  }

  private async observe(
    t: Track,
    ride: {
      id: string;
      status: string;
      type: RideType;
      cancelReason: string | null;
      mergedIntoRideId: string | null;
      riderId: string;
      driver: { name: string; phone: string } | null;
      rider: { name: string };
      passengers: { riderId: string; status: string; lockedFare: number | null }[];
    },
  ): Promise<void> {
    const who = c.bold(t.rider.name);
    const leg = ride.passengers.find((p) => p.riderId === t.rider.id)?.status ?? null;
    const driverName = ride.driver?.name.split(/\s+/)[0] ?? "the driver";

    // Merged into another driver's car ("fill the car").
    if (ride.status === "CANCELLED" && ride.cancelReason === "MERGED_INTO_ANOTHER_RIDE" && ride.mergedIntoRideId) {
      const anchor = await this.prisma.ride.findUnique({
        where: { id: ride.mergedIntoRideId },
        include: { rider: { select: { name: true } }, driver: { select: { name: true } } },
      });
      t.rideId = ride.mergedIntoRideId;
      t.rideStatus = anchor?.status ?? "MATCHED";
      t.legStatus = "WAITING";
      t.giveUpAt = null;
      t.everAccepted = true;
      stats.accepted++;
      log("🤝", c.green(`${who} was added to ${anchor?.rider.name ?? "another rider"}'s shared car`) +
        c.dim(anchor?.driver ? ` (driver ${anchor.driver.name.split(/\s+/)[0]})` : ""));
      return;
    }

    const prevStatus = t.rideStatus;
    const prevLeg = t.legStatus;
    t.rideStatus = ride.status;
    t.legStatus = leg;

    // A seat's own progress first (Shared rides move each passenger
    // separately), so a drop-off is reported even when it also completed the ride.
    if (leg !== prevLeg && ride.type === "SHARED" && prevLeg !== null) {
      const fare = ride.passengers.find((p) => p.riderId === t.rider.id)?.lockedFare;
      if (leg === "ARRIVED") log("📌", `Driver is at ${t.pickup} for ${who}`);
      if (leg === "PICKED_UP") log("🚕", `${who} got in — heading to ${t.dropoff}`);
      if (leg === "DROPPED_OFF") {
        log("🏁", c.green(`${who} was dropped off at ${t.dropoff}`) + (fare ? c.dim(` (${formatCedis(fare)})`) : ""));
        stats.completed++;
        void this.maybeRate(t, ride.id);
        this.tracks.delete(t.rider.id);
        return;
      }
      if (leg === "CANCELLED" && ride.status !== "CANCELLED") {
        log("✗", c.yellow(`The driver removed ${who} from the car`));
        this.tracks.delete(t.rider.id);
        return;
      }
    }

    if (ride.status !== prevStatus) {
      switch (ride.status) {
        case "MATCHED":
          if (prevStatus === "REQUESTED" || prevStatus === "AWAITING_RIDER_DECISION") {
            t.everAccepted = true;
            t.giveUpAt = null;
            stats.accepted++;
            log("✅", c.green(`${who}'s request was accepted by ${driverName}`));
            if (ride.driver?.phone === MOCK_DRIVER_PHONE && !this.warnedMockDriver) {
              this.warnedMockDriver = true;
              log("!", c.yellow("That was the MOCK driver, not you: the server has ENABLE_MOCK_DRIVER=true. " +
                "Set it to false in apps/server/.env.development and restart the server."));
            }
          }
          break;
        case "REQUESTED":
          if (prevStatus === "MATCHED") log("↩", c.yellow(`The driver dropped ${who}'s request — it's back in the queue`));
          else if (prevStatus === "AWAITING_RIDER_DECISION") log("🔁", `${who}'s request is searching again`);
          break;
        case "ARRIVED":
          if (ride.type === "LONE") log("📌", `Driver is at ${t.pickup} for ${who}`);
          break;
        case "IN_PROGRESS":
          if (ride.type === "LONE") log("🚕", `${who} got in — on the way to ${t.dropoff}`);
          break;
        case "AWAITING_RIDER_DECISION":
          log("⌛", c.yellow(`Nobody took ${who}'s request in time`));
          this.scheduleDecision(t, ride.type);
          break;
        case "COMPLETED":
          // Shared seats were reported (and freed) above; this is a Ride alone trip.
          log("🏁", c.green(`${who} was dropped off at ${t.dropoff} — trip complete`));
          stats.completed++;
          void this.maybeRate(t, ride.id);
          this.tracks.delete(t.rider.id);
          return;
        case "CANCELLED":
          this.logCancelled(t, ride.cancelReason);
          this.tracks.delete(t.rider.id);
          return;
      }
    }

    // Giving up — only while nobody has accepted (never after pickup).
    if (t.giveUpAt !== null && Date.now() >= t.giveUpAt) {
      t.giveUpAt = null;
      if (ride.status === "REQUESTED" && ride.id === t.requestRideId && !t.everAccepted) {
        // Look again right now: the status above can be two seconds old, and
        // a real rider can cancel an accepted ride — so without this the
        // simulator could cancel a request you had just accepted.
        const fresh = await this.prisma.ride.findUnique({
          where: { id: ride.id },
          select: { status: true, driverId: true },
        });
        if (fresh?.status !== "REQUESTED" || fresh.driverId !== null) return;
        const reason = pickSearchingCancelReason(rng);
        const res = await this.api("POST", `/rides/${ride.id}/cancel`, t.rider, { reason });
        if (res.status === 200) {
          stats.cancelledByRider++;
          log("✗", c.yellow(`${who} gave up waiting and cancelled`) + c.dim(` — "${RIDER_CANCEL_REASON_LABELS[reason]}"`));
          this.tracks.delete(t.rider.id);
        }
      }
    }
  }

  private logCancelled(t: Track, reason: string | null): void {
    const who = c.bold(t.rider.name);
    switch (reason) {
      case "NO_DRIVERS_AVAILABLE":
        stats.expired++;
        log("✗", c.yellow(`${who}'s request expired — no driver took it`));
        break;
      case "RIDER_CANCELLED":
        if (!t.everAccepted) break; // our own cancel, already logged
        log("✗", c.yellow(`${who}'s ride was cancelled`));
        break;
      case "ALL_PASSENGERS_LEFT":
        log("✗", c.yellow(`The driver cancelled ${who}'s pickup`));
        break;
      case "DRIVER_BACKED_OUT":
        log("✗", c.yellow(`The driver backed out of ${who}'s ride`));
        break;
      default:
        log("✗", c.yellow(`${who}'s ride was cancelled (${reason ?? "no reason"})`));
    }
  }

  /** Answers the "no driver yet" question the way a person would, after a pause. */
  private scheduleDecision(t: Track, type: RideType): void {
    if (t.deciding) return;
    t.deciding = true;
    const action: RiderDecisionAction = pickDecision(type, rng);
    const delay = 4_000 + Math.floor(rng() * 8_000);
    setTimeout(() => {
      void (async () => {
        t.deciding = false;
        if (this.stopped || this.tracks.get(t.rider.id) !== t || t.rideStatus !== "AWAITING_RIDER_DECISION") return;
        const res = await this.api("POST", `/rides/${t.rideId}/decision`, t.rider, { action });
        if (res.status !== 200) return;
        const who = c.bold(t.rider.name);
        if (action === "KEEP_WAITING") log("🔁", `${who} chose to keep waiting`);
        if (action === "SWITCH_TO_LONE") {
          t.type = "LONE";
          log("🔁", `${who} switched to ${c.magenta("Ride alone")} (${formatCedis(getLoneFare())})`);
        }
        if (action === "CANCEL") {
          stats.cancelledByRider++;
          log("✗", c.yellow(`${who} gave up and cancelled`));
          this.tracks.delete(t.rider.id);
        }
      })();
    }, delay);
  }

  /** Most riders rate the driver after a trip, as the rider app asks them to. */
  private async maybeRate(t: Track, rideId: string): Promise<void> {
    if (rng() > 0.7) return;
    const stars = rng() < 0.75 ? 5 : 4;
    await this.api("POST", "/ratings", t.rider, { rideId, stars }).catch(() => {});
  }

  // ── HTTP ────────────────────────────────────────────────────────────────

  private async api(
    method: "POST" | "GET",
    path: string,
    rider: SimRider,
    body?: unknown,
  ): Promise<{ status: number; body: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    assertRiderSideRequest(method, path);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });
    let res: Response;
    try {
      res = await fetch(`${this.opts.apiUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error(`can't reach the server at ${this.opts.apiUrl} — is npm run dev:server still running?`);
    }
    if (res.status === 401) {
      throw new Fatal(
        `The server rejected the simulator's sign-in (401). The server and the simulator are ` +
          `using different JWT_SECRETs, which means the server was not started from ` +
          `apps/server/.env.development.\n  Restart it with:  npm run dev:server`,
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }
}

/** Holds a rider's slot while their "same way" request is about to be sent. */
function placeholder(rider: SimRider): Track {
  return {
    rider, rideId: "", requestRideId: "", type: "SHARED", pickup: "", dropoff: "",
    rideStatus: "PENDING", legStatus: null, giveUpAt: null, deciding: false, everAccepted: false,
  };
}

// Only simulator riders are ever created here — belt and braces.
if (!SIM_PHONE_PREFIX.startsWith("+2330")) throw new Error("simulator phone prefix must be reserved");

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
