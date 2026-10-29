/**
 * `npm run sim:driver` — a fake driver ("Kwame (test)") for testing the
 * RIDER app with one phone. Development only. Steps in
 * docs/testing/SOLO_TESTING.md.
 *
 * It behaves exactly like the driver app, through the real HTTP routes and
 * the real socket, so the rider app sees what it would with a real driver:
 * it goes online at a campus place, accepts YOUR newest ride request, drives
 * the road route (POST /routes/legs — the campus route engine) to your
 * pickup sending its position about once a second, arrives, waits, picks
 * you up, drives to your drop-off and completes the trip. The database is
 * only read (to find your request) and used to create the fake driver.
 */
import "./simEnv"; // MUST stay first: loads .env.development and refuses production.
import { PrismaClient } from "@prisma/client";
import { io, type Socket } from "socket.io-client";
import {
  DRIVER_CLIENT_EVENTS,
  decodePolyline,
  haversineDistanceMeters,
  nearestZone,
  pickupPin,
  dropoffPin,
  pathLengthMeters,
  type PathPoint,
} from "@rida/shared";
import { signAccessToken } from "../../services/auth/tokens";
import { assertDevOnlyDatabase, assertLocalApiUrl } from "../../db/devDbGuard";
import { ensureSimDriver, SIM_PHONE_PREFIX } from "./simAccounts";
import {
  FAKE_DRIVER_USAGE,
  FakeDriverOptionError,
  parseFakeDriverOptions,
  pickOwnRequest,
  positionsAlong,
  shortDistance,
  type FakeDriverOptions,
} from "./fakeDriverPlan";

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = { dim: paint("2"), bold: paint("1"), green: paint("32"), yellow: paint("33"), red: paint("31") };
function log(icon: string, message: string): void {
  const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
  console.log(`${c.dim(time)}  ${icon}  ${message}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Stop extends Error {}

interface Seat {
  id: string;
  riderId: string;
  status: string;
  pickupZoneId?: string;
  dropoffZoneId?: string;
  pickupLat?: number | null;
  pickupLng?: number | null;
  pickupLabel?: string | null;
  dropoffLat?: number | null;
  dropoffLng?: number | null;
  dropoffLabel?: string | null;
}

class FakeDriver {
  private token = "";
  private socket: Socket | null = null;
  private position: PathPoint = { latitude: 0, longitude: 0 };
  private rideId: string | null = null;
  private stopped = false;
  private zones: Array<{ id: string; name: string; latitude: number; longitude: number }> = [];

  constructor(
    private readonly prisma: PrismaClient,
    private readonly opts: FakeDriverOptions,
  ) {}

  async run(): Promise<void> {
    console.log(c.bold("\nCampusRide fake driver") + c.dim("  (local / development only)"));
    console.log(c.dim(`  server: ${this.opts.apiUrl} · ${this.opts.speedKmh} km/h · waits ${this.opts.waitSec}s at pickup\n`));
    await this.checkServer();

    const driver = await ensureSimDriver(this.prisma);
    this.token = signAccessToken({ userId: driver.id, role: "DRIVER" });
    log("🚗", `Signed in as ${c.bold(driver.name)} (Toyota Corolla, GT 1234-26)`);

    this.zones = (await this.api("GET", "/zones")).body.zones;
    const start = await this.startPlace();
    this.position = start.point;
    const zone = nearestZone(start.point.latitude, start.point.longitude, this.zones);
    const online = await this.api("PATCH", "/driver/availability", { isOnline: true, zoneId: zone?.id });
    if (online.status !== 200) throw new Error(`Couldn't go online: HTTP ${online.status} ${JSON.stringify(online.body)}`);
    log("🟢", `Online at ${c.bold(start.name)}`);

    this.connectSocket();

    const request = await this.waitForRequest();
    const claim = await this.api("POST", `/rides/${request.id}/claim`);
    if (claim.status !== 200) {
      throw new Error(`Couldn't accept it: ${claim.body?.error ?? `HTTP ${claim.status}`}`);
    }
    this.rideId = request.id;
    log("✅", `Accepted ${c.bold(request.riderName)}'s ${request.type === "SHARED" ? "Shared" : "Ride alone"} request`);

    const seat = await this.mySeat();
    const ride = (await this.api("GET", "/driver/rides/active")).body.ride;
    const pickup = pickupPin(seat) ?? this.zonePoint(seat.pickupZoneId ?? ride.pickupZoneId);
    const dropoff = dropoffPin(seat) ?? this.zonePoint(seat.dropoffZoneId ?? ride.dropoffZoneId);
    const pickupName = seat.pickupLabel ?? ride.pickupZone?.name ?? "the pickup";
    const dropoffName = seat.dropoffLabel ?? ride.dropoffZone?.name ?? "the drop-off";

    await this.driveTo(pickup, `to ${pickupName}`);
    await this.passenger(seat.id, "arrived");
    log("📍", `Arrived at ${c.bold(pickupName)} — waiting ${this.opts.waitSec}s`);
    for (let i = 0; i < this.opts.waitSec; i++) {
      this.sendPosition();
      await this.stillOn(seat.id);
      await sleep(1_000);
    }
    await this.passenger(seat.id, "pickup");
    log("🧍", `Picked up ${c.bold(request.riderName)}`);

    await this.driveTo(dropoff, `to ${dropoffName}`);
    await this.passenger(seat.id, "dropoff");
    log("🏁", c.green(`Dropped off at ${c.bold(dropoffName)} — trip complete`));
    this.rideId = null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.socket?.disconnect();
    if (this.token) await this.api("PATCH", "/driver/availability", { isOnline: false }).catch(() => {});
  }

  // ── Steps ─────────────────────────────────────────────────────────────

  private async startPlace(): Promise<{ name: string; point: PathPoint }> {
    const places: Array<{ name: string; latitude: number; longitude: number }> = (await this.api("GET", "/places")).body.places ?? [];
    const q = this.opts.at.toLowerCase();
    const place = places.find((p) => p.name.toLowerCase() === q) ?? places.find((p) => p.name.toLowerCase().includes(q));
    if (place) return { name: place.name, point: { latitude: place.latitude, longitude: place.longitude } };
    const zone = this.zones.find((z) => z.name.toLowerCase().includes(q)) ?? this.zones[0];
    if (!zone) throw new Error("This database has no zones. Seed them: npm run db:seed:dev --workspace apps/server");
    log("·", c.yellow(`No campus place matches "${this.opts.at}" — starting at the ${zone.name} zone instead`));
    return { name: zone.name, point: { latitude: zone.latitude, longitude: zone.longitude } };
  }

  /** Polls for your newest open request (never a fake rider's). */
  private async waitForRequest(): Promise<{ id: string; riderName: string; type: string }> {
    let told = false;
    for (;;) {
      if (this.stopped) throw new Stop();
      const open = await this.prisma.ride.findMany({
        where: { status: "REQUESTED", driverId: null, rider: { phone: { not: { startsWith: SIM_PHONE_PREFIX } } } },
        select: { id: true, type: true, createdAt: true, rider: { select: { name: true, phone: true } } },
        orderBy: { createdAt: "desc" },
        take: 5,
      });
      const mine = pickOwnRequest(open.map((r) => ({ ...r, riderPhone: r.rider.phone })));
      if (mine) return { id: mine.id, riderName: mine.rider.name.trim().split(/\s+/)[0] ?? "the rider", type: mine.type };
      if (!told) {
        log("⏳", "Waiting for a ride request — request one in the rider app");
        told = true;
      }
      await sleep(2_000);
    }
  }

  private async mySeat(): Promise<Seat> {
    const ride = (await this.api("GET", "/driver/rides/active")).body.ride;
    if (!ride) throw new Error("The trip didn't load after accepting");
    const seats: Seat[] = ride.passengers ?? [];
    const seat = seats.find((p) => p.riderId === ride.riderId) ?? seats[0];
    if (!seat) throw new Error("The trip has no rider seat");
    return seat;
  }

  /** Drives the road to `to`, sending its position about once a second. */
  private async driveTo(to: PathPoint, label: string): Promise<void> {
    const route = await this.api("POST", "/routes/legs", { points: [this.position, to] });
    const road: PathPoint[] =
      route.status === 200 && typeof route.body?.polyline === "string" ? decodePolyline(route.body.polyline) : [];
    const path = road.length >= 2 ? [this.position, ...road.slice(1, -1), to] : [this.position, to];
    // "osrm" is the wire value for "a real road" (the campus route engine).
    const source = route.body?.source === "osrm" ? "campus road" : road.length >= 2 ? "zone roads" : "straight line";
    const total = pathLengthMeters(path);
    log("🛣", `Driving ${label} — ${shortDistance(total)} by ${source}`);

    const points = positionsAlong(path, this.opts.speedKmh);
    for (let i = 0; i < points.length; i++) {
      if (this.stopped) throw new Stop();
      this.position = points[i]!;
      this.sendPosition();
      if (i > 0 && i % 10 === 0) {
        log("·", c.dim(`${shortDistance(haversineDistanceMeters(this.position, to))} to go`));
        await this.stillOn();
      }
      await sleep(1_000);
    }
  }

  private sendPosition(): void {
    if (!this.rideId || !this.socket) return;
    this.socket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, {
      rideId: this.rideId,
      lat: this.position.latitude,
      lng: this.position.longitude,
    });
  }

  /** Stops cleanly if you cancelled the ride in the rider app. */
  private async stillOn(seatId?: string): Promise<void> {
    const ride = (await this.api("GET", "/driver/rides/active")).body.ride;
    const seat = seatId ? (ride?.passengers as Seat[] | undefined)?.find((p) => p.id === seatId) : undefined;
    if (!ride || ride.id !== this.rideId || seat?.status === "CANCELLED") {
      log("✗", c.yellow("The ride was cancelled — stopping"));
      this.rideId = null;
      throw new Stop();
    }
  }

  private async passenger(seatId: string, action: "arrived" | "pickup" | "dropoff"): Promise<void> {
    const res = await this.api("POST", `/rides/${this.rideId}/passengers/${seatId}/${action}`);
    if (res.status !== 200) {
      if (res.status === 404 || res.body?.code === "TRIP_ENDED" || res.body?.code === "PASSENGER_NOT_FOUND") {
        log("✗", c.yellow(`The ride was cancelled — stopping`));
        throw new Stop();
      }
      throw new Error(`"${action}" was refused: ${res.body?.error ?? `HTTP ${res.status}`}`);
    }
  }

  // ── Plumbing ──────────────────────────────────────────────────────────

  private zonePoint(zoneId: string): PathPoint {
    const z = this.zones.find((zone) => zone.id === zoneId);
    if (!z) throw new Error("Unknown zone on the ride");
    return { latitude: z.latitude, longitude: z.longitude };
  }

  private connectSocket(): void {
    this.socket = io(this.opts.apiUrl, { auth: { token: this.token }, transports: ["websocket"] });
    this.socket.on("connect_error", (err: Error) => log("!", c.yellow(`Socket: ${err.message}`)));
  }

  private async checkServer(): Promise<void> {
    try {
      const res = await fetch(`${this.opts.apiUrl}/health`);
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      throw new Error(`Can't reach your local server at ${this.opts.apiUrl}. Start it with: npm run dev:server`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON from our own server, like sim:riders
  private async api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

async function main(): Promise<void> {
  let opts: FakeDriverOptions;
  try {
    opts = parseFakeDriverOptions(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof FakeDriverOptionError) {
      console.error(`\n${err.message}\n${FAKE_DRIVER_USAGE}`);
      process.exit(1);
    }
    throw err;
  }
  if (opts.help) {
    console.log(FAKE_DRIVER_USAGE);
    return;
  }
  assertLocalApiUrl(opts.apiUrl, "fake driver");
  // simEnv already checked this; checked again right where the client is made.
  assertDevOnlyDatabase(process.env.DATABASE_URL ?? "", "fake driver");
  const prisma = new PrismaClient({ log: ["error"] });
  const driver = new FakeDriver(prisma, opts);

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log(c.dim("\nStopping… the driver goes offline."));
    void driver.stop().finally(() => prisma.$disconnect().finally(() => process.exit(0)));
  });

  try {
    await driver.run();
  } catch (err) {
    if (!(err instanceof Stop)) console.error(`\n${c.red("✗")} ${(err as Error).message}\n`);
    if (!(err instanceof Stop)) process.exitCode = 1;
  } finally {
    if (!stopping) {
      await driver.stop();
      await prisma.$disconnect();
      log("⏹", "Offline. Run it again for another trip.");
      process.exit(process.exitCode ?? 0); // the socket would otherwise keep the process alive
    }
  }
}

void main();
