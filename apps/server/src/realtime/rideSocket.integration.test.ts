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
