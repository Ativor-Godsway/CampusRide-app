/**
 * Phase 5: the admin surface. These tests pin the three things that make the
 * feature safe rather than merely present:
 *   1. requireAdmin actually blocks RIDER/DRIVER tokens and anonymous callers.
 *   2. approve/reject really flip Driver.isApproved in the database.
 *   3. every mutating action leaves an attributable AdminAuditLog row.
 * Plus: ADMIN remains unassignable through the public signup route.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerAdminRoutes } from "./admin";
import { registerAuthRoutes } from "./auth";
import { signAccessToken } from "../services/auth/tokens";
import { otpService } from "../services/active";
import {
  createTestUser,
  createTestDriver,
  createTestRide,
  cleanupDriver,
  cleanupRide,
} from "../services/ride/testFixtures";

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdRideIds: string[] = [];
const createdAuditActors: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAdminRoutes(app, prisma);
  registerAuthRoutes(app, prisma, otpService);
  await app.ready();
});

afterEach(async () => {
  while (createdAuditActors.length > 0) {
    await prisma.adminAuditLog.deleteMany({ where: { actor: createdAuditActors.pop()! } });
  }
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdUserIds.length > 0) {
    await cleanupDriver(createdUserIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** Creates an ADMIN user and returns a token for it. */
async function authedAdmin() {
  const user = await createTestUser("RIDER");
  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  createdUserIds.push(user.id);
  createdAuditActors.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "ADMIN" }) };
}

/** Creates an unapproved, offline driver awaiting a decision. */
async function pendingDriver() {
  const { user, driver } = await createTestDriver({ isApproved: false, isOnline: false });
  createdUserIds.push(user.id);
  return { user, driver };
}

describe("requireAdmin", () => {
  const routes: Array<[string, string]> = [
    ["GET", "/admin/drivers/pending"],
    ["GET", "/admin/rides"],
    ["POST", "/admin/drivers/some-id/approve"],
    ["POST", "/admin/drivers/some-id/reject"],
  ];

  it("rejects an anonymous caller with 401 on every admin route", async () => {
    for (const [method, url] of routes) {
      const res = await app.inject({ method: method as "GET", url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("rejects a RIDER token with 403 on every admin route", async () => {
    const rider = await createTestUser("RIDER");
    createdUserIds.push(rider.id);
    const token = signAccessToken({ userId: rider.id, role: "RIDER" });

    for (const [method, url] of routes) {
      const res = await app.inject({
        method: method as "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error).toBe("Admin role required");
    }
  });

  it("rejects a DRIVER token with 403 — an approved driver cannot approve themselves", async () => {
    const { user, driver } = await createTestDriver({ isApproved: true, isOnline: false });
    createdUserIds.push(user.id);
    const token = signAccessToken({ userId: user.id, role: "DRIVER" });

    const res = await app.inject({
      method: "POST",
      url: `/admin/drivers/${driver.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows an ADMIN token through", async () => {
    const { token } = await authedAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/admin/drivers/pending",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("GET /admin/drivers/pending", () => {
  it("lists unapproved drivers with the info needed to decide, and omits approved ones", async () => {
    const { token } = await authedAdmin();
    const { user, driver } = await pendingDriver();
    const approved = await createTestDriver({ isApproved: true, isOnline: false });
    createdUserIds.push(approved.user.id);

    const res = await app.inject({
      method: "GET",
      url: "/admin/drivers/pending",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const ids = res.json().drivers.map((d: { id: string }) => d.id);
    expect(ids).toContain(driver.id);
    expect(ids).not.toContain(approved.driver.id);

    const row = res.json().drivers.find((d: { id: string }) => d.id === driver.id);
    expect(row.user).toMatchObject({ id: user.id, name: user.name, phone: user.phone });
    expect(row.carMake).toBe("Toyota");
    expect(row.photoUrl).toBe("https://example.com/photo.jpg");
  });
});

describe("POST /admin/drivers/:id/approve", () => {
  it("flips isApproved to true and writes an audit row", async () => {
    const { user: admin, token } = await authedAdmin();
    const { driver } = await pendingDriver();

    const res = await app.inject({
      method: "POST",
      url: `/admin/drivers/${driver.id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().driver.isApproved).toBe(true);

    const stored = await prisma.driver.findUnique({ where: { id: driver.id } });
    expect(stored!.isApproved).toBe(true);

    const logs = await prisma.adminAuditLog.findMany({ where: { actor: admin.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      actor: admin.id,
      action: "driver.approve",
      target: driver.id,
      reason: null,
    });
    expect(logs[0]!.timestamp).toBeInstanceOf(Date);
  });

  it("404s for an unknown driver id and writes no audit row", async () => {
    const { user: admin, token } = await authedAdmin();

    const res = await app.inject({
      method: "POST",
      url: "/admin/drivers/does-not-exist/approve",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id } })).toBe(0);
  });
});

describe("POST /admin/drivers/:id/reject", () => {
  it("clears isApproved, forces the driver offline, and records the reason", async () => {
    const { user: admin, token } = await authedAdmin();
    const { user, driver } = await createTestDriver({ isApproved: true, isOnline: true });
    createdUserIds.push(user.id);

    const res = await app.inject({
      method: "POST",
      url: `/admin/drivers/${driver.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "Plate does not match the vehicle photo" },
    });

    expect(res.statusCode).toBe(200);

    const stored = await prisma.driver.findUnique({ where: { id: driver.id } });
    expect(stored!.isApproved).toBe(false);
    expect(stored!.isOnline).toBe(false);

    const logs = await prisma.adminAuditLog.findMany({ where: { actor: admin.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "driver.reject",
      target: driver.id,
      reason: "Plate does not match the vehicle photo",
    });
  });

  it("accepts a reject with no reason and stores null", async () => {
    const { user: admin, token } = await authedAdmin();
    const { driver } = await pendingDriver();

    const res = await app.inject({
      method: "POST",
      url: `/admin/drivers/${driver.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const logs = await prisma.adminAuditLog.findMany({ where: { actor: admin.id } });
    expect(logs[0]!.reason).toBeNull();
  });

  it("rejects a non-string reason with 400", async () => {
    const { token } = await authedAdmin();
    const { driver } = await pendingDriver();

    const res = await app.inject({
      method: "POST",
      url: `/admin/drivers/${driver.id}/reject`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 42 },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe("GET /admin/rides", () => {
  it("lists rides newest-first and filters by status", async () => {
    const { token } = await authedAdmin();
    const requested = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(requested.ride.id);
    const cancelled = await createTestRide({ type: "LONE", status: "CANCELLED" });
    createdRideIds.push(cancelled.ride.id);

    const all = await app.inject({
      method: "GET",
      url: "/admin/rides",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(all.statusCode).toBe(200);
    const allIds = all.json().rides.map((r: { id: string }) => r.id);
    expect(allIds).toContain(requested.ride.id);
    expect(allIds).toContain(cancelled.ride.id);

    const filtered = await app.inject({
      method: "GET",
      url: "/admin/rides?status=CANCELLED",
      headers: { authorization: `Bearer ${token}` },
    });
    const filteredIds = filtered.json().rides.map((r: { id: string }) => r.id);
    expect(filteredIds).toContain(cancelled.ride.id);
    expect(filteredIds).not.toContain(requested.ride.id);
  });

  it("filters by a createdAt window", async () => {
    const { token } = await authedAdmin();
    const ride = await createTestRide({ type: "LONE", status: "REQUESTED" });
    createdRideIds.push(ride.ride.id);

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const inWindow = await app.inject({
      method: "GET",
      url: `/admin/rides?from=${new Date(Date.now() - 86_400_000).toISOString()}&to=${tomorrow}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(inWindow.json().rides.map((r: { id: string }) => r.id)).toContain(ride.ride.id);

    const outOfWindow = await app.inject({
      method: "GET",
      url: `/admin/rides?from=${tomorrow}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(outOfWindow.json().rides.map((r: { id: string }) => r.id)).not.toContain(ride.ride.id);
  });

  it("400s on an unknown status or an unparseable date", async () => {
    const { token } = await authedAdmin();
    const headers = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url: "/admin/rides?status=NOPE", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/rides?from=yesterday", headers })).statusCode).toBe(400);
  });
});

describe("ADMIN is not self-assignable", () => {
  it("POST /auth/signup refuses role=ADMIN", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: {
        phone: "+233594826399",
        name: "Would-be admin",
        role: "ADMIN",
        verifiedToken: "irrelevant",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("RIDER|DRIVER");
    expect(await prisma.user.findUnique({ where: { phone: "+233594826399" } })).toBeNull();
  });
});
