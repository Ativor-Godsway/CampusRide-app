/**
 * Who may touch what — the permission matrix for EVERY HTTP route.
 *
 * Three layers:
 *
 * 1. ROUTE_ACCESS classifies every route the server registers (the same
 *    table index.ts registers, via registerAllRoutes). A route that is added
 *    without being classified fails "every route is classified", and
 *    docs/security/route-inventory.md must list exactly these routes with the
 *    same login requirement.
 * 2. Every signed-in route refuses no token, an OTP verification token
 *    (signed with the same secret, but not an access token) and the token of
 *    a deleted account; every admin route refuses riders and drivers.
 * 3. OWNERSHIP_CASES: for every route whose URL or body names someone's
 *    resource, user B tries it on user A's — rider vs rider, driver vs
 *    another driver's trip, passenger vs the booking rider — and gets the
 *    same answer as for a resource that doesn't exist, with nothing changed.
 *
 * Socket.io events have the same matrix in realtime/rideSocket.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { PassengerStatus, Ride, RideStatus, RideType, User } from "@prisma/client";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken, signVerificationToken } from "../services/auth/tokens";
import { deleteAccount } from "../services/auth/deleteAccount";
import { login } from "../services/auth/authService";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { newToken } from "../services/push/testFixtures";

// ─── The classification ────────────────────────────────────────────────────

type Access =
  /** No login. The credential, if any, is something else (named in the inventory). */
  | "public"
  /** Any signed-in account; returns nobody's personal data. */
  | "signed-in"
  /** Acts only on the caller's own account; nothing in the request names anyone else. */
  | "self"
  /** The URL or body names a ride/seat/rating that must be the caller's: OWNERSHIP_CASES covers it. */
  | "owner"
  /** ADMIN accounts only. */
  | "admin";

const ROUTE_ACCESS: Record<string, Access> = {
  "GET /health": "public",
  "GET /health/ready": "public",
  "POST /auth/request-otp": "public",
  "POST /auth/verify-otp": "public",
  "POST /auth/signup": "public",
  "POST /auth/login": "public",
  "POST /auth/refresh": "public",
  "POST /auth/logout": "public",
  "POST /demo/otp/send": "public",
  "POST /demo/otp/verify": "public",
  "POST /webhooks/moolre": "public",
  "POST /ussd/callback": "public",
  "GET /track/:token": "public",

  "GET /zones": "signed-in",
  "GET /zones/routes": "signed-in",
  "GET /places": "signed-in",
  "GET /places/search": "signed-in",
  "GET /service-area": "signed-in",
  "POST /routes/legs": "signed-in",

  "GET /me": "self",
  "PATCH /me": "self",
  "POST /me/terms": "self",
  "DELETE /me": "self",
  "POST /me/deletion-code": "self",
  "PUT /me/push-token": "self",
  "DELETE /me/push-token": "self",
  "POST /driver/profile": "self",
  "PATCH /driver/profile": "self",
  "PATCH /driver/availability": "self",
  "PATCH /driver/zone": "self",
  "GET /driver/rides/active": "self",
  "GET /driver/rides/history": "self",
  "GET /driver/rides/eligible": "self",
  "GET /rides/mine": "self",
  "GET /rides/active": "self",
  "POST /rides": "self",
  "POST /uploads/driver-photo/signature": "self",
  "POST /uploads/driver-photo/failure": "self",

  "GET /rides/:id": "owner",
  "POST /rides/:id/decision": "owner",
  "POST /rides/:id/cancel": "owner",
  "POST /rides/:id/switch": "owner",
  "POST /rides/:id/initiate-payment": "owner",
  "GET /rides/:id/payment-status": "owner",
  "POST /rides/:id/sos": "owner",
  "POST /ratings": "owner",
  "POST /ratings/rider": "owner",
  "GET /rides/:id/rateable-riders": "owner",
  "POST /rides/:id/claim": "owner",
  "POST /rides/:id/reject": "owner",
  "POST /rides/:id/arrived": "owner",
  "POST /rides/:id/depart": "owner",
  "POST /rides/:id/complete": "owner",
  "GET /rides/:id/fill-suggestions": "owner",
  "GET /rides/:id/add-preview": "owner",
  "POST /rides/:id/add-passenger": "owner",
  "POST /rides/:id/passengers/:passengerId/arrived": "owner",
  "POST /rides/:id/passengers/:passengerId/pickup": "owner",
  "POST /rides/:id/passengers/:passengerId/dropoff": "owner",
  "POST /rides/:id/passengers/:passengerId/cancel": "owner",
  "POST /rides/:id/passengers/:passengerId/no-show": "owner",

  "GET /admin/drivers/pending": "admin",
  "POST /admin/drivers/:id/approve": "admin",
  "POST /admin/drivers/:id/reject": "admin",
  "GET /admin/rides": "admin",
  "GET /admin/places": "admin",
  "POST /admin/places": "admin",
  "PATCH /admin/places/:id": "admin",
  "GET /admin/rate-limits": "admin",
  "GET /admin/audit/logins": "admin",
  "POST /admin/rate-limits/clear": "admin",
  "GET /admin/account-deletion": "admin",
  "POST /admin/account-deletion/code": "admin",
  "POST /admin/account-deletion/verify": "admin",
  "POST /admin/account-deletion/delete": "admin",
};

// ─── App, people and rides ─────────────────────────────────────────────────

let app: FastifyInstance;
const registered: string[] = [];
const userIds: string[] = [];

interface Person {
  user: User;
  token: string;
}

async function person(role: "RIDER" | "DRIVER" | "ADMIN"): Promise<Person> {
  const created = await createTestUser(role === "DRIVER" ? "DRIVER" : "RIDER");
  const user =
    role === "ADMIN"
      ? await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } })
      : created;
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: user.role }) };
}

async function driverPerson(): Promise<Person> {
  const { pickup } = await getTestZones();
  const { user } = await createTestDriver({
    isOnline: true,
    isApproved: true,
    currentZoneId: pickup.id,
  });
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

async function ride(opts: {
  type: RideType;
  status: RideStatus;
  riderId: string;
  driverId?: string | null;
  seats?: Array<{ riderId: string; status: PassengerStatus }>;
  completedAt?: Date;
}): Promise<Ride & { seatIds: Record<string, string> }> {
  const { pickup, dropoff } = await getTestZones();
  const created = await prisma.ride.create({
    data: {
      riderId: opts.riderId,
      driverId: opts.driverId ?? null,
      type: opts.type,
      status: opts.status,
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      occupancy: Math.max(1, opts.seats?.length ?? 1),
      broadcastStartedAt: new Date(),
      decisionStartedAt: opts.status === "AWAITING_RIDER_DECISION" ? new Date() : null,
      completedAt: opts.completedAt ?? (opts.status === "COMPLETED" ? new Date() : null),
      passengers: {
        create: (opts.seats ?? [{ riderId: opts.riderId, status: "WAITING" as const }]).map(
          (s) => ({
            riderId: s.riderId,
            pickupZoneId: pickup.id,
            dropoffZoneId: dropoff.id,
            status: s.status,
            lockedFare: 500,
          }),
        ),
      },
    },
    include: { passengers: true },
  });
  const seatIds = Object.fromEntries(created.passengers.map((p) => [p.riderId, p.id]));
  return { ...created, seatIds };
}

function call(method: string, url: string, token?: string, payload?: unknown) {
  return app.inject({
    method: method as "GET",
    url,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(payload !== undefined && method !== "GET" ? { payload: payload as object } : {}),
  });
}

/** The fixed cast. A books, C rides along with A, B is a stranger, D1 drives A's car, D2 drives someone else's. */
interface World {
  riderA: Person;
  riderB: Person;
  passengerC: Person;
  noShowN: Person;
  driver1: Person;
  driver2: Person;
  admin: Person;
  /** SHARED, MATCHED: A booked it, C was added, D1 drives. */
  car: Awaited<ReturnType<typeof ride>>;
  /** A's REQUESTED request (cancel/switch target). */
  searching: Awaited<ReturnType<typeof ride>>;
  /** A's AWAITING_RIDER_DECISION request. */
  deciding: Awaited<ReturnType<typeof ride>>;
  /** D1's LONE trip with A at the pickup (ARRIVED) — depart target. */
  loneArrived: Awaited<ReturnType<typeof ride>>;
  /** D1's LONE trip under way — complete target. */
  loneMoving: Awaited<ReturnType<typeof ride>>;
  /** SHARED, COMPLETED by D1: A and C carried, N never showed. */
  done: Awaited<ReturnType<typeof ride>>;
  /** Someone's open SHARED request, for add-passenger. */
  openRequest: Awaited<ReturnType<typeof ride>>;
}

let w: World;

beforeAll(async () => {
  app = Fastify();
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD") registered.push(`${m} ${r.url}`);
  });
  registerAllRoutes(app, prisma, {
    otpService: new DummyOtpService(),
    paymentService: new DummyPaymentService(),
    // Dormant in this launch, but they are routes: classify and test them too.
    paymentsEnabled: true,
    ussdEnabled: true,
  });
  await app.ready();

  const [riderA, riderB, passengerC, noShowN, driver1, driver2, admin, requester] =
    await Promise.all([
      person("RIDER"),
      person("RIDER"),
      person("RIDER"),
      person("RIDER"),
      driverPerson(),
      driverPerson(),
      person("ADMIN"),
      person("RIDER"),
    ]);
  const a = riderA.user.id;
  w = {
    riderA,
    riderB,
    passengerC,
    noShowN,
    driver1,
    driver2,
    admin,
    car: await ride({
      type: "SHARED",
      status: "MATCHED",
      riderId: a,
      driverId: driver1.user.id,
      seats: [
        { riderId: a, status: "WAITING" },
        { riderId: passengerC.user.id, status: "WAITING" },
      ],
    }),
    searching: await ride({ type: "SHARED", status: "REQUESTED", riderId: a }),
    deciding: await ride({ type: "SHARED", status: "AWAITING_RIDER_DECISION", riderId: a }),
    loneArrived: await ride({
      type: "LONE",
      status: "ARRIVED",
      riderId: a,
      driverId: driver1.user.id,
    }),
    loneMoving: await ride({
      type: "LONE",
      status: "IN_PROGRESS",
      riderId: a,
      driverId: driver1.user.id,
      seats: [{ riderId: a, status: "PICKED_UP" }],
    }),
    done: await ride({
      type: "SHARED",
      status: "COMPLETED",
      riderId: a,
      driverId: driver1.user.id,
      seats: [
        { riderId: a, status: "DROPPED_OFF" },
        { riderId: passengerC.user.id, status: "DROPPED_OFF" },
        { riderId: noShowN.user.id, status: "CANCELLED" },
      ],
    }),
    openRequest: await ride({ type: "SHARED", status: "REQUESTED", riderId: requester.user.id }),
  };
});

afterAll(async () => {
  await prisma.ride.deleteMany({
    where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

// ─── 1. Classification and the inventory ───────────────────────────────────

describe("route classification", () => {
  it("every registered route is classified, and every classified route exists", () => {
    expect([...registered].sort()).toEqual(Object.keys(ROUTE_ACCESS).sort());
  });

  it("docs/security/route-inventory.md lists exactly these routes, with the same login rule", () => {
    const doc = readFileSync(
      path.resolve(__dirname, "../../../../docs/security/route-inventory.md"),
      "utf8",
    );
    const rows = [
      ...doc.matchAll(/^\|\s*`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`\s*\|\s*(Yes|No)\b/gm),
    ];
    const documented = new Map(rows.map((m) => [`${m[1]} ${m[2]}`, m[3] === "Yes"]));
    expect([...documented.keys()].sort()).toEqual(Object.keys(ROUTE_ACCESS).sort());
    for (const [route, loginRequired] of documented) {
      expect(loginRequired, route).toBe(ROUTE_ACCESS[route] !== "public");
    }
  });
});

// ─── 2. Signed-in and admin gates, over every route ────────────────────────

/** A concrete URL for a route pattern (ids that exist, so a 401 isn't a 404 in disguise). */
function urlFor(route: string): { method: string; url: string } {
  const [method, pattern] = route.split(" ") as [string, string];
  const url = pattern
    .replace(":passengerId", w.car.seatIds[w.riderA.user.id]!)
    .replace(":id", pattern.startsWith("/admin/drivers") ? "some-driver" : w.car.id)
    .replace(":token", "0".repeat(32));
  return { method, url };
}

describe("signed-in routes refuse anyone not signed in", () => {
  const gated = () => Object.keys(ROUTE_ACCESS).filter((r) => ROUTE_ACCESS[r] !== "public");

  it("with no token", async () => {
    for (const route of gated()) {
      const { method, url } = urlFor(route);
      expect((await call(method, url)).statusCode, route).toBe(401);
    }
  });

  it("with an OTP verification token (same secret, not an access token)", async () => {
    const otpToken = signVerificationToken({ phone: w.riderA.user.phone, purpose: "LOGIN" });
    for (const route of gated()) {
      const { method, url } = urlFor(route);
      expect((await call(method, url, otpToken, {})).statusCode, route).toBe(401);
    }
  });

  it("with an unexpired token of a deleted account", async () => {
    const leaver = await person("RIDER");
    await deleteAccount(prisma, leaver.user.id);
    for (const route of gated()) {
      const { method, url } = urlFor(route);
      expect((await call(method, url, leaver.token, {})).statusCode, route).toBe(401);
    }
  });
});

describe("admin routes are ADMIN only", () => {
  const adminRoutes = () => Object.keys(ROUTE_ACCESS).filter((r) => ROUTE_ACCESS[r] === "admin");

  it("refuse riders and drivers with 403, changing nothing", async () => {
    for (const who of [w.riderA, w.driver1]) {
      for (const route of adminRoutes()) {
        const { method, url } = urlFor(route);
        expect(
          (await call(method, url, who.token, { name: "x", latitude: 5.65, longitude: -0.19 }))
            .statusCode,
          route,
        ).toBe(403);
      }
    }
    expect(
      await prisma.adminAuditLog.count({
        where: { actor: { in: [w.riderA.user.id, w.driver1.user.id] } },
      }),
    ).toBe(0);
  });

  it("go by the database role, not the role written in the token", async () => {
    const forged = signAccessToken({ userId: w.riderA.user.id, role: "ADMIN" });
    for (const route of adminRoutes()) {
      const { method, url } = urlFor(route);
      expect((await call(method, url, forged, {})).statusCode, route).toBe(403);
    }
  });

  it("let a real admin in", async () => {
    expect((await call("GET", "/admin/drivers/pending", w.admin.token)).statusCode).toBe(200);
    expect((await call("GET", "/admin/rides", w.admin.token)).statusCode).toBe(200);
  });
});

// ─── 3. Ownership: B tries A's things ──────────────────────────────────────

interface OwnershipCase {
  route: string;
  name: string;
  run: () => Promise<{ status: number; body: Record<string, unknown> }>;
  expectStatus: number;
  /** The exact body; for a 404 without a code it defaults to the "doesn't exist" body. */
  expectBody?: Record<string, unknown>;
  /** Proves nothing changed. */
  unchanged?: () => Promise<void>;
}

const ride404 = { error: "Ride not found" };

async function statusOf(id: string) {
  return (await prisma.ride.findUniqueOrThrow({ where: { id } })).status;
}

async function seatStatus(seatId: string) {
  return (await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seatId } })).status;
}

function cases(): OwnershipCase[] {
  const as = async (who: Person, method: string, url: string, payload?: unknown) => {
    const res = await call(method, url, who.token, payload);
    return {
      status: res.statusCode,
      body: res.body ? (res.json() as Record<string, unknown>) : {},
    };
  };
  const { riderA, riderB, passengerC, noShowN, driver1, driver2, car, searching, deciding, done } =
    w;
  const seatA = car.seatIds[riderA.user.id]!;

  const passengerActions = ["arrived", "pickup", "dropoff", "cancel", "no-show"].map(
    (action): OwnershipCase => ({
      route: `POST /rides/:id/passengers/:passengerId/${action}`,
      name: `another driver can't ${action} a rider on D1's car`,
      run: () => as(driver2, "POST", `/rides/${car.id}/passengers/${seatA}/${action}`, {}),
      expectStatus: 404,
      unchanged: async () => expect(await seatStatus(seatA)).toBe("WAITING"),
    }),
  );

  return [
    // Rider vs rider
    {
      route: "GET /rides/:id",
      name: "rider B can't read rider A's ride",
      run: () => as(riderB, "GET", `/rides/${car.id}`),
      expectStatus: 404,
    },
    {
      route: "POST /rides/:id/decision",
      name: "rider B can't decide for rider A",
      run: () => as(riderB, "POST", `/rides/${deciding.id}/decision`, { action: "CANCEL" }),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(deciding.id)).toBe("AWAITING_RIDER_DECISION"),
    },
    {
      route: "POST /rides/:id/cancel",
      name: "rider B can't cancel rider A's request",
      run: () => as(riderB, "POST", `/rides/${searching.id}/cancel`, {}),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(searching.id)).toBe("REQUESTED"),
    },
    {
      route: "POST /rides/:id/cancel",
      name: "a passenger can't cancel the car of the rider who booked it",
      run: () => as(passengerC, "POST", `/rides/${car.id}/cancel`, {}),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(car.id)).toBe("MATCHED"),
    },
    {
      route: "POST /rides/:id/switch",
      name: "rider B can't switch rider A's request",
      run: () => as(riderB, "POST", `/rides/${searching.id}/switch`, { type: "LONE" }),
      expectStatus: 404,
      unchanged: async () =>
        expect((await prisma.ride.findUniqueOrThrow({ where: { id: searching.id } })).type).toBe(
          "SHARED",
        ),
    },
    {
      route: "POST /rides/:id/initiate-payment",
      name: "rider B can't pay into (or probe) rider A's ride",
      run: async () => {
        const moolre = config.moolre as { paymentsEnabled: boolean };
        const before = moolre.paymentsEnabled;
        moolre.paymentsEnabled = true;
        try {
          return await as(riderB, "POST", `/rides/${done.id}/initiate-payment`, {
            phone: "0244000000",
            network: "MTN",
          });
        } finally {
          moolre.paymentsEnabled = before;
        }
      },
      expectStatus: 404,
      unchanged: async () =>
        expect(await prisma.payment.count({ where: { rideId: done.id } })).toBe(0),
    },
    {
      route: "GET /rides/:id/payment-status",
      name: "rider B can't read rider A's payment",
      run: () => as(riderB, "GET", `/rides/${done.id}/payment-status`),
      expectStatus: 404,
    },
    {
      route: "POST /rides/:id/sos",
      name: "rider B can't raise an SOS on rider A's ride",
      run: () => as(riderB, "POST", `/rides/${car.id}/sos`, {}),
      expectStatus: 404,
      unchanged: async () =>
        expect(await prisma.trackingLink.count({ where: { rideId: car.id } })).toBe(0),
    },
    {
      route: "POST /ratings",
      name: "rider B can't rate rider A's driver for A's ride",
      run: () => as(riderB, "POST", "/ratings", { rideId: done.id, stars: 1 }),
      expectStatus: 404,
      unchanged: async () =>
        expect(await prisma.rating.count({ where: { rideId: done.id } })).toBe(0),
    },
    {
      route: "POST /ratings",
      name: "a rider whose seat was cancelled didn't take the trip and can't rate it",
      run: () => as(noShowN, "POST", "/ratings", { rideId: done.id, stars: 1 }),
      expectStatus: 403,
      unchanged: async () =>
        expect(await prisma.rating.count({ where: { rideId: done.id } })).toBe(0),
    },

    // Driver vs another driver's trip
    {
      route: "POST /rides/:id/claim",
      name: "another driver can't take over D1's trip",
      run: () => as(driver2, "POST", `/rides/${car.id}/claim`),
      expectStatus: 409,
      unchanged: async () =>
        expect((await prisma.ride.findUniqueOrThrow({ where: { id: car.id } })).driverId).toBe(
          driver1.user.id,
        ),
    },
    {
      route: "POST /rides/:id/reject",
      name: "another driver can't decline D1's trip",
      run: () => as(driver2, "POST", `/rides/${car.id}/reject`, {}),
      expectStatus: 409,
      unchanged: async () =>
        expect(await prisma.rideRejection.count({ where: { rideId: car.id } })).toBe(0),
    },
    {
      route: "POST /rides/:id/arrived",
      name: "another driver can't mark D1's trip arrived",
      run: () => as(driver2, "POST", `/rides/${car.id}/arrived`),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(car.id)).toBe("MATCHED"),
    },
    {
      route: "POST /rides/:id/depart",
      name: "another driver can't depart D1's trip (or learn its type)",
      run: () => as(driver2, "POST", `/rides/${w.loneArrived.id}/depart`),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(w.loneArrived.id)).toBe("ARRIVED"),
    },
    {
      route: "POST /rides/:id/complete",
      name: "another driver can't complete D1's trip",
      run: () => as(driver2, "POST", `/rides/${w.loneMoving.id}/complete`),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(w.loneMoving.id)).toBe("IN_PROGRESS"),
    },
    {
      route: "GET /rides/:id/fill-suggestions",
      name: "another driver can't read D1's car",
      run: () => as(driver2, "GET", `/rides/${car.id}/fill-suggestions`),
      expectStatus: 404,
    },
    {
      route: "GET /rides/:id/add-preview",
      name: "another driver can't preview D1's car",
      run: () =>
        as(driver2, "GET", `/rides/${car.id}/add-preview?requestRideId=${w.openRequest.id}`),
      expectStatus: 404,
    },
    {
      route: "POST /rides/:id/add-passenger",
      name: "another driver can't add riders to D1's car",
      run: () =>
        as(driver2, "POST", `/rides/${car.id}/add-passenger`, { requestRideId: w.openRequest.id }),
      expectStatus: 404,
      unchanged: async () => expect(await statusOf(w.openRequest.id)).toBe("REQUESTED"),
    },
    ...passengerActions,
    {
      route: "GET /rides/:id/rateable-riders",
      name: "another driver can't list D1's riders",
      run: () => as(driver2, "GET", `/rides/${done.id}/rateable-riders`),
      expectStatus: 404,
    },
    {
      route: "POST /ratings/rider",
      name: "another driver can't rate D1's rider",
      run: () =>
        as(driver2, "POST", "/ratings/rider", {
          rideId: done.id,
          riderId: riderA.user.id,
          stars: 1,
        }),
      expectStatus: 404,
      unchanged: async () =>
        expect(await prisma.rating.count({ where: { rideId: done.id } })).toBe(0),
    },
    {
      route: "POST /ratings/rider",
      name: "D1 can't rate a rider who never got in (no-show)",
      run: () =>
        as(driver1, "POST", "/ratings/rider", {
          rideId: done.id,
          riderId: noShowN.user.id,
          stars: 1,
        }),
      expectStatus: 404,
      expectBody: { error: "That rider was not on this ride" },
      unchanged: async () =>
        expect(await prisma.rating.count({ where: { rideId: done.id } })).toBe(0),
    },
  ];
}

describe("ownership: user B cannot read or change user A's resources", () => {
  it("every owner route has at least one cross-user case", () => {
    const covered = new Set(cases().map((c) => c.route));
    const owned = Object.keys(ROUTE_ACCESS).filter((r) => ROUTE_ACCESS[r] === "owner");
    expect(owned.filter((r) => !covered.has(r))).toEqual([]);
  });

  it("each case is refused, says no more than 'not found', and changes nothing", async () => {
    for (const c of cases()) {
      const res = await c.run();
      expect(res.status, c.name).toBe(c.expectStatus);
      if (c.expectBody) expect(res.body, c.name).toEqual(c.expectBody);
      else if (c.expectStatus === 404 && res.body.code === undefined)
        expect(res.body, c.name).toEqual(ride404);
      await c.unchanged?.();
    }
  });

  it("the people who own it still get in (the 404s above are not a broken route)", async () => {
    const { riderA, passengerC, driver1, car, done } = w;
    expect((await call("GET", `/rides/${car.id}`, riderA.token)).statusCode).toBe(200);
    expect((await call("GET", `/rides/${car.id}`, passengerC.token)).statusCode).toBe(200);
    expect((await call("GET", `/rides/${car.id}/fill-suggestions`, driver1.token)).statusCode).toBe(
      200,
    );
    const rateable = await call("GET", `/rides/${done.id}/rateable-riders`, driver1.token);
    expect(rateable.statusCode).toBe(200);
    // Only riders who were carried are offered for rating.
    expect(
      rateable
        .json()
        .riders.map((r: { riderId: string }) => r.riderId)
        .sort(),
    ).toEqual([riderA.user.id, passengerC.user.id].sort());
  });

  it("riders can't use driver routes and drivers can't use rider routes", async () => {
    const { riderA, driver1, car } = w;
    expect((await call("POST", `/rides/${car.id}/arrived`, riderA.token)).statusCode).toBe(403);
    expect((await call("GET", "/driver/rides/active", riderA.token)).statusCode).toBe(403);
    expect((await call("GET", `/rides/${car.id}`, driver1.token)).statusCode).toBe(403);
    expect((await call("POST", `/rides/${car.id}/sos`, driver1.token, {})).statusCode).toBe(403);
  });
});

// ─── Self routes: nothing in the request can point them at someone else ───

describe("self routes act on the caller only", () => {
  it("GET /me and GET /rides/mine ignore any id in the request", async () => {
    const me = await call("GET", `/me?userId=${w.riderB.user.id}`, w.riderA.token);
    expect(me.json().user.id).toBe(w.riderA.user.id);
    const mine = await call("GET", `/rides/mine?riderId=${w.riderB.user.id}`, w.riderA.token);
    expect(
      mine.json().rides.every((r: { riderId: string }) => r.riderId === w.riderA.user.id),
    ).toBe(true);
  });

  it("DELETE /me/push-token can't remove another person's token", async () => {
    const theirs = newToken();
    await prisma.pushToken.create({
      data: { userId: w.riderB.user.id, token: theirs, app: "rider", platform: "android" },
    });
    expect(
      (await call("DELETE", "/me/push-token", w.riderA.token, { token: theirs })).statusCode,
    ).toBe(200);
    expect(
      await prisma.pushToken.count({ where: { token: theirs, userId: w.riderB.user.id } }),
    ).toBe(1);
  });

  it("GET /driver/rides/active is the caller's own trip", async () => {
    const res = await call("GET", "/driver/rides/active", w.driver2.token);
    expect(res.json().ride).toBeNull();
  });
});

// ─── Mass assignment: only allow-listed fields are ever written ────────────

describe("mass assignment: protected fields in a request body are ignored", () => {
  it("PATCH /me can't set role, phone, deletion or another account", async () => {
    const victim = w.riderB.user;
    const res = await call("PATCH", "/me", w.riderA.token, {
      name: "Ama Renamed",
      role: "ADMIN",
      phone: victim.phone,
      id: victim.id,
      userId: victim.id,
      deletedAt: new Date().toISOString(),
    });
    expect(res.statusCode).toBe(200);
    const me = await prisma.user.findUniqueOrThrow({ where: { id: w.riderA.user.id } });
    expect(me).toMatchObject({
      name: "Ama Renamed",
      role: "RIDER",
      phone: w.riderA.user.phone,
      deletedAt: null,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: victim.id } })).name).toBe(
      victim.name,
    );
  });

  it("driver profile writes can't approve, put online or re-own a driver", async () => {
    const pending = await createTestDriver({ isOnline: false, isApproved: false });
    userIds.push(pending.user.id);
    const token = signAccessToken({ userId: pending.user.id, role: "DRIVER" });
    const sneaky = {
      isApproved: true,
      isOnline: true,
      userId: w.driver1.user.id,
      currentZoneId: "x",
      role: "ADMIN",
    };

    await call("PATCH", "/driver/profile", token, { carColor: "Red", ...sneaky });
    await call("POST", "/driver/profile", token, {
      carMake: "Kia",
      carModel: "Rio",
      carColor: "Red",
      plate: "GR 1-26",
      ...sneaky,
    });
    expect(
      (await call("PATCH", "/driver/availability", token, { isOnline: true, isApproved: true }))
        .statusCode,
    ).toBe(403);

    const row = await prisma.driver.findUniqueOrThrow({
      where: { userId: pending.user.id },
      include: { user: true },
    });
    expect(row).toMatchObject({
      isApproved: false,
      isOnline: false,
      carColor: "Red",
      userId: pending.user.id,
    });
    expect(row.user.role).toBe("DRIVER");
  });

  it("POST /rides can't set its rider, driver, status or fare", async () => {
    const booker = await person("RIDER");
    const { pickup, dropoff } = await getTestZones();
    const res = await call("POST", "/rides", booker.token, {
      pickupZoneId: pickup.id,
      dropoffZoneId: dropoff.id,
      type: "LONE",
      riderId: w.riderB.user.id,
      driverId: w.driver1.user.id,
      status: "COMPLETED",
      fareTotal: 1,
      driverShare: 1,
      occupancy: 4,
      paymentStatus: "DISBURSED",
      trackingToken: "a".repeat(32),
    });
    expect(res.statusCode).toBe(201);
    const row = await prisma.ride.findUniqueOrThrow({
      where: { id: res.json().ride.id },
      include: { passengers: true },
    });
    expect(row).toMatchObject({
      riderId: booker.user.id,
      driverId: null,
      status: "REQUESTED",
      fareTotal: null,
      driverShare: null,
      occupancy: 1,
      paymentStatus: "PENDING",
      trackingToken: null,
    });
    expect(row.passengers.map((p) => p.riderId)).toEqual([booker.user.id]);
  });

  it("ratings can't be written in someone else's name", async () => {
    const res = await call("POST", "/ratings", w.passengerC.token, {
      rideId: w.done.id,
      stars: 4,
      raterId: w.riderB.user.id,
      rateeId: w.riderA.user.id,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().rating).toMatchObject({
      raterId: w.passengerC.user.id,
      rateeId: w.driver1.user.id,
    });
    await prisma.rating.deleteMany({ where: { rideId: w.done.id } });
  });

  it("PUT /me/push-token registers to the caller, whatever userId is sent", async () => {
    const token = newToken();
    await call("PUT", "/me/push-token", w.riderA.token, {
      token,
      app: "rider",
      platform: "ios",
      userId: w.riderB.user.id,
    });
    expect((await prisma.pushToken.findUniqueOrThrow({ where: { token } })).userId).toBe(
      w.riderA.user.id,
    );
  });

  it("signup can't create an admin, or an approved driver", async () => {
    const phone = `+23324${String(Date.now()).slice(-7)}`;
    const verifiedToken = signVerificationToken({ phone, purpose: "SIGNUP" });
    expect(
      (
        await call("POST", "/auth/signup", undefined, {
          phone,
          name: "X",
          role: "ADMIN",
          ageAndTermsConfirmed: true,
          verifiedToken,
        })
      ).statusCode,
    ).toBe(400);
    const res = await call("POST", "/auth/signup", undefined, {
      phone,
      name: "Kofi",
      role: "DRIVER",
      ageAndTermsConfirmed: true,
      verifiedToken,
      isApproved: true,
      driver: { isApproved: true },
    });
    expect(res.statusCode).toBe(201);
    userIds.push(res.json().user.id);
    expect(
      (await prisma.driver.findUniqueOrThrow({ where: { userId: res.json().user.id } })).isApproved,
    ).toBe(false);
  });
});

// ─── Soft-deleted accounts ─────────────────────────────────────────────────

describe("a deleted account can't log in or keep a session", () => {
  it("refuses login and refresh", async () => {
    const leaver = await person("RIDER");
    const phone = leaver.user.phone;
    const verifiedToken = signVerificationToken({ phone, purpose: "LOGIN" });
    const session = await login(prisma, { phone, verifiedToken });
    await deleteAccount(prisma, leaver.user.id);

    expect(
      (await call("POST", "/auth/login", undefined, { phone, verifiedToken })).statusCode,
    ).toBe(404);
    expect(
      (await call("POST", "/auth/refresh", undefined, { refreshToken: session.refreshToken }))
        .statusCode,
    ).toBe(401);
    expect((await call("GET", "/me", session.accessToken)).statusCode).toBe(401);
  });
});

// ─── What one party sees of another ────────────────────────────────────────

describe("contact details stop with the trip", () => {
  it("a cancelled ride doesn't show the rider the driver's phone", async () => {
    const r = await ride({
      type: "LONE",
      status: "CANCELLED",
      riderId: w.riderB.user.id,
      driverId: w.driver2.user.id,
    });
    const res = await call("GET", `/rides/${r.id}`, w.riderB.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().driver.phone).toBeNull();
  });

  it("a driver doesn't get the phone of a rider who has left the car", async () => {
    const r = await ride({
      type: "SHARED",
      status: "IN_PROGRESS",
      riderId: w.riderB.user.id,
      driverId: w.driver2.user.id,
      seats: [
        { riderId: w.riderB.user.id, status: "DROPPED_OFF" },
        { riderId: w.noShowN.user.id, status: "CANCELLED" },
        { riderId: w.passengerC.user.id, status: "PICKED_UP" },
      ],
    });
    const res = await call("GET", "/driver/rides/active", w.driver2.token);
    const trip = res.json().ride;
    expect(trip.id).toBe(r.id);
    const phoneOf = (riderId: string) =>
      trip.passengers.find((p: { riderId: string }) => p.riderId === riderId).riderPhone;
    expect(phoneOf(w.passengerC.user.id)).toBe(w.passengerC.user.phone);
    expect(phoneOf(w.riderB.user.id)).toBeNull();
    expect(phoneOf(w.noShowN.user.id)).toBeNull();
    expect(trip.riderPhone).toBeNull();
    await prisma.ride.delete({ where: { id: r.id } });
  });
});
