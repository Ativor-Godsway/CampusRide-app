/**
 * The shared-ride simulation's world: a REAL local server (every HTTP route
 * + Socket.io) on 127.0.0.1, with drivers and riders who act only through
 * it — HTTP for their taps, a real socket.io client each for what the apps
 * hear. Used by the integration test (sharedRides.simulation.test.ts) and
 * `npm run simulate:shared` (cli.ts), which prints the timeline.
 *
 * Time is simulated: `advance(ms)` moves the clock by back-dating the
 * world's own requests (broadcastStartedAt, arrivedAt) and running the
 * timeout sweep for them, so "90 seconds later" takes no real time. Only
 * the world's own accounts and rides are touched, and cleanup() deletes
 * them.
 */
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { Server as SocketServer } from "socket.io";
import { io as connect, type Socket } from "socket.io-client";
import type { PrismaClient, Zone } from "@prisma/client";
import { DRIVER_EVENTS, RIDE_CLIENT_EVENTS, RIDE_EVENTS } from "@rida/shared";
import { registerAllRoutes } from "../../routes";
import { DummyOtpService } from "../../services/otp/DummyOtpService";
import { DummyPaymentService } from "../../services/payment/DummyPaymentService";
import { initRideSocket } from "../../realtime/rideSocket";
import { signAccessToken } from "../../services/auth/tokens";
import { processTimeouts } from "../../services/ride/timeouts";
import { uniqueGhanaPhone } from "../../test/testPhone";

/** A step failed: what was expected, in words. */
export class SimFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimFailure";
  }
}

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SimFailure(message);
}

type Heard = { event: string; payload: Record<string, unknown>; at: number };

interface HttpAnswer {
  status: number;
  body: Record<string, unknown>;
}

const SIM_TAG = "(shared-sim)";
/** How long a "live" update may take to reach a phone before it counts as not live. */
const LIVE_MS = 3_000;

export class World {
  private app!: FastifyInstance;
  private io!: SocketServer;
  private url = "";
  private sockets: Socket[] = [];
  readonly userIds: string[] = [];
  readonly rideIds = new Set<string>();
  readonly lines: string[] = [];
  private clockMs: number;
  zones!: { pickup: Zone; dropoff: Zone };

  constructor(
    readonly prisma: PrismaClient,
    private readonly print: (line: string) => void = () => {},
    /** The clock the timeline starts at (10:00:00 by default). */
    startAt = new Date(2026, 10, 9, 10, 0, 0),
  ) {
    this.clockMs = startAt.getTime();
  }

  async start(): Promise<void> {
    this.app = Fastify();
    registerAllRoutes(this.app, this.prisma, {
      otpService: new DummyOtpService(),
      paymentService: new DummyPaymentService(),
    });
    await this.app.listen({ port: 0, host: "127.0.0.1" });
    this.io = new SocketServer(this.app.server);
    initRideSocket(this.io, this.prisma);
    this.url = `http://127.0.0.1:${(this.app.server.address() as AddressInfo).port}`;

    const zones = await this.prisma.zone.findMany({ where: { retiredAt: null }, orderBy: { name: "asc" }, take: 2 });
    check(zones.length === 2, "The database needs at least two zones (npm run db:seed:test / db:seed:dev)");
    this.zones = { pickup: zones[0]!, dropoff: zones[1]! };
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.close();
    this.sockets = [];
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    await this.app.close();
  }

  // ─── The timeline ─────────────────────────────────────────────────────────

  clock(): string {
    return new Date(this.clockMs).toTimeString().slice(0, 8);
  }

  log(text: string): void {
    const line = `${this.clock()}  ${text}`;
    this.lines.push(line);
    this.print(line);
  }

  heading(text: string): void {
    this.lines.push("", text);
    this.print("");
    this.print(text);
  }

  /** A few seconds pass between taps, as on a phone. */
  tick(seconds = 5): void {
    this.clockMs += seconds * 1000;
  }

  /**
   * `ms` pass: the world's searching requests and arrived riders are made
   * that much older, then the timeout sweep runs for the world's rides.
   */
  async advance(ms: number): Promise<void> {
    this.clockMs += ms;
    const ids = [...this.rideIds];
    await this.prisma.$executeRaw`
      UPDATE "Ride" SET "broadcastStartedAt" = "broadcastStartedAt" - (${ms} * interval '1 millisecond')
      WHERE id = ANY(${ids}) AND "broadcastStartedAt" IS NOT NULL AND status IN ('REQUESTED', 'AWAITING_RIDER_DECISION')`;
    await this.prisma.$executeRaw`
      UPDATE "RidePassenger" SET "arrivedAt" = "arrivedAt" - (${ms} * interval '1 millisecond')
      WHERE "rideId" = ANY(${ids}) AND "arrivedAt" IS NOT NULL`;
    await processTimeouts(this.prisma, new Date(), { rideIds: ids, logger: { info: () => {}, warn: () => {} } });
  }

  /** Polls `read` until it gives something (up to 3 s): for what the server does just after a reply. */
  async until<T>(read: () => Promise<T | null | undefined>): Promise<T | null> {
    const deadline = Date.now() + LIVE_MS;
    for (;;) {
      const value = await read();
      if (value != null || Date.now() > deadline) return value ?? null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ─── People ───────────────────────────────────────────────────────────────

  async rider(name: string): Promise<SimRider> {
    const user = await this.prisma.user.create({
      data: { phone: uniqueGhanaPhone(), name: `${name} ${SIM_TAG}`, role: "RIDER" },
    });
    this.userIds.push(user.id);
    const token = signAccessToken({ userId: user.id, role: "RIDER" });
    return new SimRider(this, name, user.id, token, await this.socketFor(token));
  }

  async driver(name: string): Promise<SimDriver> {
    const user = await this.prisma.user.create({
      data: { phone: uniqueGhanaPhone(), name: `${name} ${SIM_TAG}`, role: "DRIVER" },
    });
    this.userIds.push(user.id);
    const { pickup } = this.zones;
    await this.prisma.driver.create({
      data: {
        userId: user.id,
        carMake: "Toyota",
        carModel: "Vitz",
        carColor: "Silver",
        plate: `SIM-${user.id.slice(-8).toUpperCase()}`,
        isApproved: true,
        isOnline: true,
        currentZoneId: pickup.id,
        lastLat: pickup.latitude,
        lastLng: pickup.longitude,
        lastSeenAt: new Date(),
      },
    });
    const token = signAccessToken({ userId: user.id, role: "DRIVER" });
    return new SimDriver(this, name, user.id, token, await this.socketFor(token));
  }

  private async socketFor(token: string): Promise<Socket> {
    const socket = connect(this.url, { auth: { token }, transports: ["websocket"], reconnection: false, forceNew: true });
    this.sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return socket;
  }

  async http(token: string, method: "GET" | "POST" | "PATCH", path: string, payload?: Record<string, unknown>): Promise<HttpAnswer> {
    const res = await this.app.inject({
      method,
      url: path,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
    const text = res.body;
    return { status: res.statusCode, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────

  /** Deletes everything this world made (its rides first: a rider can't go while a ride names them). */
  async cleanup(): Promise<void> {
    const ids = this.userIds.splice(0);
    if (ids.length === 0) return;
    const rides = await this.prisma.ride.findMany({
      where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }, { passengers: { some: { riderId: { in: ids } } } }] },
      select: { id: true },
    });
    const rideIds = rides.map((r) => r.id);
    await this.prisma.rating.deleteMany({ where: { rideId: { in: rideIds } } });
    await this.prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
    await this.prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
    await this.prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
    await this.prisma.driver.deleteMany({ where: { userId: { in: ids } } });
    await this.prisma.user.deleteMany({ where: { id: { in: ids } } });
    this.rideIds.clear();
  }
}

/** Someone with a phone: their socket's events are kept, newest last. */
abstract class Person {
  readonly heard: Heard[] = [];

  constructor(
    protected readonly world: World,
    readonly name: string,
    readonly id: string,
    protected readonly token: string,
    protected readonly socket: Socket,
  ) {
    socket.onAny((event: string, payload: unknown) => {
      this.heard.push({ event, payload: (payload ?? {}) as Record<string, unknown>, at: Date.now() });
    });
  }

  protected http(method: "GET" | "POST" | "PATCH", path: string, payload?: Record<string, unknown>) {
    return this.world.http(this.token, method, path, payload);
  }

  /** Waits (up to LIVE_MS) for an event matching `match` heard after `since`; null if none came. */
  async hear(event: string, match: (payload: Record<string, unknown>) => boolean, since: number, ms = LIVE_MS): Promise<Heard | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.heard.find((h) => h.at >= since && h.event === event && match(h.payload));
      if (found) return found;
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** True if nothing matching was heard after `since` (waits a moment for stragglers first). */
  async heardNothing(event: string, match: (payload: Record<string, unknown>) => boolean, since: number): Promise<boolean> {
    return (await this.hear(event, match, since, 400)) === null;
  }
}

export class SimRider extends Person {
  /** This rider's request (their own ride until a driver merges them into a car). */
  requestId: string | null = null;

  /** Books Pickup → Drop-off, as the app does. `seats` > 1 isn't bookable from any app: it is written to the row. */
  async request(type: "SHARED" | "LONE", seats = 1): Promise<string> {
    const { pickup, dropoff } = this.world.zones;
    const res = await this.http("POST", "/rides", {
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      type,
      paymentMethod: "CASH",
    });
    check(res.status === 201, `${this.name} couldn't book: ${res.status} ${JSON.stringify(res.body)}`);
    const id = (res.body.ride as { id: string }).id;
    if (seats > 1) await this.world.prisma.ride.update({ where: { id }, data: { occupancy: seats } });
    this.requestId = id;
    this.world.rideIds.add(id);
    // Its room, as the rider app subscribes to it.
    await this.socket.timeout(3000).emitWithAck(RIDE_CLIENT_EVENTS.SUBSCRIBE, id);
    const kind = type === "SHARED" ? `Shared${seats > 1 ? `, ${seats} seats` : ""}` : "Ride alone";
    this.world.log(`${this.name} requests a ride (${kind})`);
    return id;
  }

  /** What the rider's screen shows: "searching", "no drivers", "driver coming", "cancelled"… */
  async screen(): Promise<string> {
    check(this.requestId, `${this.name} has no request`);
    const res = await this.http("GET", `/rides/${this.requestId}`);
    const ride = res.body.ride as { status: string; mergedIntoRideId?: string | null } | undefined;
    if (!ride) return `unknown (${res.status})`;
    if (ride.mergedIntoRideId) return "in a shared car";
    return (
      { REQUESTED: "searching", AWAITING_RIDER_DECISION: "no drivers", MATCHED: "driver coming", CANCELLED: "cancelled" } as Record<
        string,
        string
      >
    )[ride.status] ?? ride.status.toLowerCase();
  }

  /** Cancels: the whole request while searching, or their own seat once in a car. */
  async cancel(carId?: string): Promise<void> {
    const id = carId ?? this.requestId;
    const res = await this.http("POST", `/rides/${id}/cancel`, {});
    check(res.status === 200, `${this.name}'s cancel failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.world.log(`${this.name} cancels${carId ? " their seat" : ""}`);
  }

  /** The fare summaries this rider's phone got (`ride:completed`). */
  fareSummaries(): Array<{ rideId: string; yourFarePesewas: number }> {
    return this.heard
      .filter((h) => h.event === RIDE_EVENTS.COMPLETED)
      .map((h) => ({ rideId: h.payload.rideId as string, ...(h.payload.fareSummary as { yourFarePesewas: number }) }));
  }
}

export interface AcceptAnswer {
  ok: boolean;
  status: number;
  code?: string;
  reason?: string;
  message?: string;
}

export class SimDriver extends Person {
  /** The trip under way, once this driver has one. */
  carId: string | null = null;

  /** The driver's requests list as the app shows it: Home with no trip, the mid-trip list on a Shared car. */
  async list(): Promise<string[]> {
    await this.syncCar();
    const ours = (ids: string[]) => ids.filter((id) => this.world.rideIds.has(id));
    if (!this.carId) {
      const res = await this.http("GET", "/driver/rides/eligible");
      return ours(((res.body.rides ?? []) as Array<{ rideId: string }>).map((r) => r.rideId));
    }
    const res = await this.http("GET", `/rides/${this.carId}/fill-suggestions`);
    if (res.status !== 200) return [];
    return ours(((res.body.suggestions ?? []) as Array<{ requestRideId: string }>).map((s) => s.requestRideId));
  }

  /** The Home list entry for a request (with its offerTimedOut flag). */
  async listed(rideId: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.http("GET", "/driver/rides/eligible");
    return ((res.body.rides ?? []) as Array<Record<string, unknown>>).find((r) => r.rideId === rideId);
  }

  async freeSeats(): Promise<number> {
    await this.syncCar();
    if (!this.carId) return 4;
    const res = await this.http("GET", `/rides/${this.carId}/fill-suggestions`);
    const seated = ((res.body.passengers ?? []) as unknown[]).length;
    return (res.body.freeSeats as number | undefined) ?? 4 - seated;
  }

  /** The Earnings totals (GET /driver/rides/history): what's owed in commission, what the driver keeps. */
  async earnings(): Promise<{ commissionOwedPesewas: number; netPesewas: number }> {
    const res = await this.http("GET", "/driver/rides/history");
    return res.body.summary as { commissionOwedPesewas: number; netPesewas: number };
  }

  /** A pop-up: the server offered this request to this driver (ride:broadcast) after `since`. */
  async poppedUp(rideId: string, since: number): Promise<boolean> {
    return (await this.hear(DRIVER_EVENTS.RIDE_BROADCAST, (p) => p.rideId === rideId, since)) !== null;
  }

  async neverPoppedUp(rideId: string, since: number): Promise<boolean> {
    return this.heardNothing(DRIVER_EVENTS.RIDE_BROADCAST, (p) => p.rideId === rideId, since);
  }

  /** Waits for the server to say this request is gone (ride:offer_closed). */
  async heardClosed(rideId: string, since: number): Promise<string | null> {
    const h = await this.hear(DRIVER_EVENTS.OFFER_CLOSED, (p) => p.rideId === rideId, since);
    return (h?.payload.reason as string | undefined) ?? null;
  }

  /** Accept: claims with no trip, adds to the car with one — as the app does. */
  async accept(rideId: string, label = rideId): Promise<AcceptAnswer> {
    await this.syncCar();
    const res = this.carId
      ? await this.http("POST", `/rides/${this.carId}/add-passenger`, { requestRideId: rideId })
      : await this.http("POST", `/rides/${rideId}/claim`);
    const answer: AcceptAnswer = {
      ok: res.status === 200,
      status: res.status,
      code: res.body.code as string | undefined,
      reason: res.body.reason as string | undefined,
      message: res.body.error as string | undefined,
    };
    if (answer.ok && !this.carId) this.carId = rideId;
    this.world.log(answer.ok ? `${this.name} accepts ${label}` : `${this.name} taps Accept on ${label}: "${answer.message}"`);
    return answer;
  }

  /** The pop-up's Reject, or its countdown running out. */
  async pass(rideId: string, reason: "DECLINED" | "TIMED_OUT", label = rideId): Promise<void> {
    const res = await this.http("POST", `/rides/${rideId}/reject`, { reason });
    check(res.status === 200, `${this.name}'s ${reason} failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.world.log(reason === "DECLINED" ? `${this.name} rejects ${label}` : `${this.name}'s pop-up for ${label} times out`);
  }

  async goOffline(): Promise<void> {
    const res = await this.http("PATCH", "/driver/availability", { isOnline: false });
    check(res.status === 200, `${this.name} couldn't go offline: ${res.status}`);
    this.world.log(`${this.name} goes offline`);
  }

  /** A step on one rider's seat: arrived, pickup, dropoff, cancel, no-show, undo. */
  async seat(
    rider: SimRider,
    action: "arrived" | "pickup" | "dropoff" | "cancel" | "no-show" | "undo-pickup" | "undo-dropoff",
  ): Promise<HttpAnswer> {
    await this.syncCar();
    check(this.carId, `${this.name} has no trip`);
    const seat = await this.world.prisma.ridePassenger.findFirst({ where: { rideId: this.carId, riderId: rider.id } });
    check(seat, `${rider.name} isn't in ${this.name}'s car`);
    const base = `/rides/${this.carId}/passengers/${seat.id}`;
    const res =
      action === "undo-pickup" || action === "undo-dropoff"
        ? await this.http("POST", `${base}/undo`, { step: action === "undo-pickup" ? "pickup" : "dropoff" })
        : action === "no-show"
          ? await this.http("POST", `${base}/cancel`, { reason: "NO_SHOW" })
          : await this.http("POST", `${base}/${action}`);
    const words: Record<string, string> = {
      arrived: `arrives for ${rider.name}`,
      pickup: `picks up ${rider.name}`,
      dropoff: `drops off ${rider.name}`,
      cancel: `cancels ${rider.name}'s seat`,
      "no-show": `marks ${rider.name} a no-show`,
      "undo-pickup": `undoes ${rider.name}'s pickup`,
      "undo-dropoff": `undoes ${rider.name}'s drop-off`,
    };
    this.world.log(
      res.status === 200 ? `${this.name} ${words[action]}` : `${this.name} tries to ${action} ${rider.name}: "${res.body.error as string}"`,
    );
    return res;
  }

  /** Picks the rider up as the app does from the Stops list: the arrival, then the pickup. */
  async pickUp(rider: SimRider): Promise<void> {
    check((await this.seat(rider, "arrived")).status === 200, `${this.name} couldn't arrive for ${rider.name}`);
    this.world.tick(2);
    check((await this.seat(rider, "pickup")).status === 200, `${this.name} couldn't pick up ${rider.name}`);
  }

  async dropOff(rider: SimRider): Promise<void> {
    check((await this.seat(rider, "dropoff")).status === 200, `${this.name} couldn't drop off ${rider.name}`);
  }

  private async syncCar(): Promise<void> {
    const res = await this.http("GET", "/driver/rides/active");
    const ride = res.body.ride as { id: string } | null | undefined;
    this.carId = ride?.id ?? null;
    if (ride) this.world.rideIds.add(ride.id);
  }
}
