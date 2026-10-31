/**
 * The permission matrix for Socket.io, over a real server and real clients:
 * who may connect, who may join a ride's room, whose driver positions are
 * relayed, and what happens to a socket whose rider leaves the car or whose
 * account is deleted. (HTTP routes: routes/authorization.test.ts.)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import type { PassengerStatus, RideStatus, UserRole } from "@prisma/client";
import { DRIVER_CLIENT_EVENTS, RIDE_CLIENT_EVENTS, RIDE_EVENTS } from "@rida/shared";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { signAccessToken, signVerificationToken } from "../services/auth/tokens";
import { deleteAccount } from "../services/auth/deleteAccount";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { RULES } from "../rateLimit/rules";
import { limiter } from "../rateLimit/limiter";
import { freshDriverPositions, resetLivePositionsForTests } from "../services/zones/livePositions";
import { resetDriverPresenceForTests, silentDrivers } from "../services/zones/driverPresence";
import {
  SOCKET_AUTH_ERROR,
  disconnectUser,
  emitRideEvent,
  initRideSocket,
  removeRiderFromRide,
} from "./rideSocket";

let httpServer: HttpServer;
let io: Server;
let url: string;
const open: ClientSocket[] = [];
const userIds: string[] = [];

beforeAll(async () => {
  httpServer = createServer();
  io = new Server(httpServer);
  initRideSocket(io, prisma);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterEach(() => {
  while (open.length) open.pop()!.close();
});

afterAll(async () => {
  await prisma.ride.deleteMany({
    where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

/** Connects with `auth.token`; resolves once admitted, rejects with the server's reason. */
function connectAs(token?: unknown): Promise<ClientSocket> {
  const socket = connect(url, {
    auth: token === undefined ? {} : { token },
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  open.push(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

async function refusal(token?: unknown): Promise<string> {
  try {
    await connectAs(token);
    return "admitted";
  } catch (err) {
    return (err as Error).message;
  }
}

async function subscribe(socket: ClientSocket, rideId: unknown): Promise<boolean> {
  const { ok } = (await socket.timeout(5000).emitWithAck(RIDE_CLIENT_EVENTS.SUBSCRIBE, rideId)) as {
    ok: boolean;
  };
  return ok;
}

/** Everything `event` delivers to `socket` within `ms`. */
function collect<T>(socket: ClientSocket, event: string, ms: number): Promise<T[]> {
  const seen: T[] = [];
  const handler = (payload: T) => seen.push(payload);
  socket.on(event, handler);
  return new Promise((resolve) =>
    setTimeout(() => {
      socket.off(event, handler);
      resolve(seen);
    }, ms),
  );
}

const tokenFor = (user: { id: string; role: UserRole }) =>
  signAccessToken({ userId: user.id, role: user.role });

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  return user;
}

async function driver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  userIds.push(user.id);
  return user;
}

async function car(
  status: RideStatus,
  driverId: string,
  seats: Array<{ riderId: string; status: PassengerStatus }>,
) {
  const { pickup, dropoff } = await getTestZones();
  return prisma.ride.create({
    data: {
      riderId: seats[0]!.riderId,
      driverId,
      type: "SHARED",
      status,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      occupancy: seats.length,
      passengers: {
        create: seats.map((s) => ({
          ...s,
          pickupZoneId: pickup.id,
          dropoffZoneId: dropoff.id,
          lockedFare: 500,
        })),
      },
    },
  });
}

describe("handshake", () => {
  it("refuses every kind of bad credential with the same message", async () => {
    const someone = await rider();
    const payload = { userId: someone.id, role: "RIDER", typ: "access" };
    const unsigned = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(payload)).toString("base64url"),
      "",
    ].join(".");
    const leaver = await rider();
    const leaverToken = tokenFor(leaver);
    await deleteAccount(prisma, leaver.id);

    const bad: Record<string, unknown> = {
      "no token": undefined,
      "not a string": 12345,
      garbage: "not-a-jwt",
      "signed with another secret": jwt.sign(payload, "some-other-secret"),
      "alg none": unsigned,
      expired: jwt.sign({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }, config.jwtSecret),
      "OTP verification token": signVerificationToken({ phone: someone.phone, purpose: "LOGIN" }),
      "deleted account": leaverToken,
      "account that never existed": signAccessToken({ userId: "c-no-such-user", role: "RIDER" }),
    };
    for (const [name, token] of Object.entries(bad)) {
      expect(await refusal(token), name).toBe(SOCKET_AUTH_ERROR);
    }
  });

  it("admits a valid access token", async () => {
    const someone = await rider();
    const socket = await connectAs(tokenFor(someone));
    expect(socket.connected).toBe(true);
  });
});

describe("ride rooms and driver positions", () => {
  async function scene() {
    const [booker, passenger, droppedOff, noShow, stranger, ownDriver, otherDriver] =
      await Promise.all([rider(), rider(), rider(), rider(), rider(), driver(), driver()]);
    const trip = await car("IN_PROGRESS", ownDriver.id, [
      { riderId: booker.id, status: "PICKED_UP" },
      { riderId: passenger.id, status: "WAITING" },
      { riderId: droppedOff.id, status: "DROPPED_OFF" },
      { riderId: noShow.id, status: "CANCELLED" },
    ]);
    return { booker, passenger, droppedOff, noShow, stranger, ownDriver, otherDriver, trip };
  }

  it("lets in the driver and riders still in the car — nobody else", async () => {
    const s = await scene();
    const expected: Array<[string, { id: string; role: UserRole }, boolean]> = [
      ["booking rider", s.booker, true],
      ["passenger waiting", s.passenger, true],
      ["the car's driver", s.ownDriver, true],
      ["stranger", s.stranger, false],
      ["rider already dropped off", s.droppedOff, false],
      ["rider whose seat was cancelled", s.noShow, false],
      ["another driver", s.otherDriver, false],
    ];
    for (const [name, who, allowed] of expected) {
      const socket = await connectAs(tokenFor(who));
      expect(await subscribe(socket, s.trip.id), name).toBe(allowed);
    }
  });

  it("answers a missing ride exactly like someone else's, and ignores malformed ids", async () => {
    const s = await scene();
    const socket = await connectAs(tokenFor(s.stranger));
    for (const bad of [
      "c-no-such-ride",
      { id: s.trip.id },
      42,
      "x".repeat(65),
      "../../etc",
      null,
    ]) {
      expect(await subscribe(socket, bad)).toBe(false);
    }
    expect(socket.connected).toBe(true);
  });

  it("only room members hear the ride's events", async () => {
    const s = await scene();
    const member = await connectAs(tokenFor(s.booker));
    const outsider = await connectAs(tokenFor(s.stranger));
    expect(await subscribe(member, s.trip.id)).toBe(true);
    expect(await subscribe(outsider, s.trip.id)).toBe(false);

    const memberHears = collect(member, RIDE_EVENTS.STATUS, 400);
    const outsiderHears = collect(outsider, RIDE_EVENTS.STATUS, 400);
    emitRideEvent(s.trip.id, RIDE_EVENTS.STATUS, { rideId: s.trip.id, status: "IN_PROGRESS" });
    expect(await memberHears).toHaveLength(1);
    expect(await outsiderHears).toHaveLength(0);
  });

  it("relays positions from the car's own driver only, and drops malformed ones without disconnecting", async () => {
    const s = await scene();
    const listener = await connectAs(tokenFor(s.booker));
    expect(await subscribe(listener, s.trip.id)).toBe(true);
    const own = await connectAs(tokenFor(s.ownDriver));
    const other = await connectAs(tokenFor(s.otherDriver));
    const riderSocket = await connectAs(tokenFor(s.passenger));

    const heard = collect<{ lat: number; lng: number }>(
      listener,
      RIDE_EVENTS.DRIVER_LOCATION,
      1200,
    );
    // Refused: another driver, a rider, and positions no phone could report.
    other.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: s.trip.id, lat: 1, lng: 1 });
    riderSocket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: s.trip.id, lat: 2, lng: 2 });
    for (const junk of [
      { rideId: s.trip.id, lat: 999, lng: 0 },
      { rideId: s.trip.id, lat: "5.6", lng: "-0.18" },
      { rideId: { $ne: null }, lat: 3, lng: 3 },
      { lat: 4, lng: 4 },
      "5.6,-0.18",
      null,
    ]) {
      own.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, junk);
    }
    await new Promise((r) => setTimeout(r, 300));
    // The one that counts.
    own.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: s.trip.id, lat: 5.65, lng: -0.186 });

    expect((await heard).map((p) => [p.lat, p.lng])).toEqual([[5.65, -0.186]]);
    expect(own.connected && other.connected && riderSocket.connected).toBe(true);
  });

  it("a rider removed from the car stops hearing it", async () => {
    const s = await scene();
    const leaving = await connectAs(tokenFor(s.passenger));
    const staying = await connectAs(tokenFor(s.booker));
    expect(await subscribe(leaving, s.trip.id)).toBe(true);
    expect(await subscribe(staying, s.trip.id)).toBe(true);

    removeRiderFromRide(s.passenger.id, s.trip.id);
    const leavingHears = collect(leaving, RIDE_EVENTS.STATUS, 400);
    const stayingHears = collect(staying, RIDE_EVENTS.STATUS, 400);
    emitRideEvent(s.trip.id, RIDE_EVENTS.STATUS, { rideId: s.trip.id, status: "IN_PROGRESS" });
    expect(await leavingHears).toHaveLength(0);
    expect(await stayingHears).toHaveLength(1);
  });
});

describe("each rider's road ETA", () => {
  it("goes to each rider's own socket only, from their driver's position", async () => {
    const [waiting, aboard, stranger, ownDriver] = await Promise.all([rider(), rider(), rider(), driver()]);
    const trip = await car("IN_PROGRESS", ownDriver.id, [
      { riderId: waiting.id, status: "WAITING" },
      { riderId: aboard.id, status: "PICKED_UP" },
    ]);
    // Exact pins on campus roads (the test zones may lie off them).
    await prisma.ridePassenger.updateMany({
      where: { rideId: trip.id, riderId: waiting.id },
      data: { pickupLat: 5.65201, pickupLng: -0.18705 },
    });
    await prisma.ridePassenger.updateMany({
      where: { rideId: trip.id, riderId: aboard.id },
      data: { dropoffLat: 5.64208, dropoffLng: -0.1856 },
    });
    const [waitingSocket, aboardSocket, strangerSocket, driverSocket] = await Promise.all([
      connectAs(tokenFor(waiting)),
      connectAs(tokenFor(aboard)),
      connectAs(tokenFor(stranger)),
      connectAs(tokenFor(ownDriver)),
    ]);
    const heardWaiting = collect<{ toward: string; seconds: number; rideId: string }>(waitingSocket, RIDE_EVENTS.ETA, 800);
    const heardAboard = collect<{ toward: string }>(aboardSocket, RIDE_EVENTS.ETA, 800);
    const heardStranger = collect(strangerSocket, RIDE_EVENTS.ETA, 800);
    driverSocket.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: trip.id, lat: 5.6515, lng: -0.18969 });

    const [w] = await heardWaiting;
    expect(w).toMatchObject({ rideId: trip.id, toward: "pickup" });
    expect(w!.seconds).toBeGreaterThan(0);
    expect((await heardAboard).map((e) => e.toward)).toEqual(["dropoff"]);
    expect(await heardStranger).toEqual([]);
  });
});

describe("a driver's presence (in touch with the phone)", () => {
  it("is tracked from the driver's socket and app state; the answer says if they were taken offline", async () => {
    resetDriverPresenceForTests();
    const d = await driver();
    const sock = await connectAs(tokenFor(d));
    const ask = (state: unknown) =>
      new Promise<{ takenOffline: boolean }>((resolve) => sock.emit(DRIVER_CLIENT_EVENTS.PRESENCE, { state }, resolve));
    expect(await ask("foreground")).toEqual({ takenOffline: false });
    expect(await ask("nonsense")).toEqual({ takenOffline: false });

    // Connected: never silent, however long.
    const later = Date.now() + 10 * config.driverSilenceTimeoutMinutes * 60_000;
    expect(silentDrivers(later).map((s) => s.userId)).not.toContain(d.id);
    sock.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    expect(silentDrivers(later).map((s) => s.userId)).toContain(d.id);
  });

  it("an app that said 'background' is never silent after its socket goes", async () => {
    resetDriverPresenceForTests();
    const d = await driver();
    const sock = await connectAs(tokenFor(d));
    await new Promise((resolve) => sock.emit(DRIVER_CLIENT_EVENTS.PRESENCE, { state: "background" }, resolve));
    sock.disconnect();
    await new Promise((r) => setTimeout(r, 200));
    expect(silentDrivers(Date.now() + 10 * config.driverSilenceTimeoutMinutes * 60_000)).toEqual([]);
  });
});

describe("an idle driver's position (Home map cars)", () => {
  it("is kept from the driver's own socket only, one per window; malformed ones and riders' are ignored", async () => {
    resetLivePositionsForTests();
    const [idleDriver, someRider] = await Promise.all([driver(), rider()]);
    const driverSocket = await connectAs(tokenFor(idleDriver));
    const riderSocket = await connectAs(tokenFor(someRider));

    riderSocket.emit(DRIVER_CLIENT_EVENTS.POSITION_UPDATE, { lat: 5.65, lng: -0.187 });
    for (const junk of [null, "x", { lat: 5.65 }, { lat: "5.6", lng: -0.18 }, { lat: 91, lng: 0 }, { lat: Infinity, lng: 0 }]) {
      driverSocket.emit(DRIVER_CLIENT_EVENTS.POSITION_UPDATE, junk);
    }
    driverSocket.emit(DRIVER_CLIENT_EVENTS.POSITION_UPDATE, { lat: 5.652, lng: -0.187 });
    // A second inside the window is dropped.
    driverSocket.emit(DRIVER_CLIENT_EVENTS.POSITION_UPDATE, { lat: 5.7, lng: -0.1 });
    await new Promise((r) => setTimeout(r, 300));

    const kept = freshDriverPositions(60_000);
    expect(kept.has(someRider.id)).toBe(false);
    expect(kept.get(idleDriver.id)).toMatchObject({ latitude: 5.652, longitude: -0.187 });
    expect(driverSocket.connected).toBe(true);
  });
});

describe("socket rate limits", () => {
  it("relays at most one position per driver per window, dropping extras silently; drivers don't share a window", async () => {
    const [booker, otherBooker, ownDriver, otherDriver] = await Promise.all([rider(), rider(), driver(), driver()]);
    const tripA = await car("IN_PROGRESS", ownDriver.id, [{ riderId: booker.id, status: "PICKED_UP" }]);
    const tripB = await car("IN_PROGRESS", otherDriver.id, [{ riderId: otherBooker.id, status: "PICKED_UP" }]);
    const listenerA = await connectAs(tokenFor(booker));
    const listenerB = await connectAs(tokenFor(otherBooker));
    expect(await subscribe(listenerA, tripA.id)).toBe(true);
    expect(await subscribe(listenerB, tripB.id)).toBe(true);
    const driverA = await connectAs(tokenFor(ownDriver));
    const driverB = await connectAs(tokenFor(otherDriver));

    const heardA = collect<{ lat: number }>(listenerA, RIDE_EVENTS.DRIVER_LOCATION, 600);
    const heardB = collect<{ lat: number }>(listenerB, RIDE_EVENTS.DRIVER_LOCATION, 600);
    for (let i = 0; i < 5; i++) driverA.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: tripA.id, lat: 5.6 + i / 1000, lng: -0.18 });
    driverB.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: tripB.id, lat: 5.7, lng: -0.18 });
    expect(await heardA).toHaveLength(1);
    expect(await heardB).toHaveLength(1);
    expect(driverA.connected).toBe(true);

    // After the window, the next position goes through again.
    await new Promise((r) => setTimeout(r, RULES.driverLocation.windowMs + 100));
    const heardAgain = collect(listenerA, RIDE_EVENTS.DRIVER_LOCATION, 500);
    driverA.emit(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, { rideId: tripA.id, lat: 5.61, lng: -0.18 });
    expect(await heardAgain).toHaveLength(1);
  });

  it("answers no to subscriptions past the account's limit, without affecting anyone else", async () => {
    const [booker, other, ownDriver] = await Promise.all([rider(), rider(), driver()]);
    const trip = await car("MATCHED", ownDriver.id, [
      { riderId: booker.id, status: "WAITING" },
      { riderId: other.id, status: "WAITING" },
    ]);
    for (let i = 0; i < RULES.socketSubscribe.max; i++) {
      await limiter.consume([{ rule: RULES.socketSubscribe, subject: booker.id }]);
    }
    const limited = await connectAs(tokenFor(booker));
    const fine = await connectAs(tokenFor(other));
    expect(await subscribe(limited, trip.id)).toBe(false);
    expect(await subscribe(fine, trip.id)).toBe(true);
  });
});

describe("a deleted account", () => {
  it("is disconnected at once and can't come back with the same token", async () => {
    const leaver = await rider();
    const token = tokenFor(leaver);
    const socket = await connectAs(token);
    const reason = new Promise<string>((resolve) => socket.once("disconnect", resolve));

    await deleteAccount(prisma, leaver.id);
    disconnectUser(leaver.id);

    expect(await reason).toBe("io server disconnect");
    expect(await refusal(token)).toBe(SOCKET_AUTH_ERROR);
  });
});
