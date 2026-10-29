/**
 * Launch mode (the countdown before the public launch). Pins:
 *   1. GET /launch-status: the mode in force, the launch time, the server's clock;
 *   2. during the countdown the server refuses a normal rider's booking with
 *      the words every app version shows (422 LAUNCH_NOT_OPEN), and books nothing;
 *   3. early-access riders, review demo accounts and admins can ride;
 *   4. at the launch time it is LIVE by itself, with nobody changing anything;
 *   5. every change in the admin site is in the audit log; "all current
 *      riders" reaches only open rider accounts that exist at that moment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerLaunchRoutes } from "./launch";
import { signAccessToken } from "../services/auth/tokens";
import { createTestUser, getTestZones } from "../services/ride/testFixtures";
import {
  assertCanBook,
  clearLaunchCache,
  launchStatus,
  setEarlyAccess,
  setLaunchMode,
} from "../services/launch/launchSettings";
import { deleteAccount } from "../services/auth/deleteAccount";

let app: FastifyInstance;
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerLaunchRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  await prisma.launchSetting.deleteMany({});
  clearLaunchCache();
  const ids = userIds.splice(0);
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actor: { in: ids } }, { target: { in: ids } }] } });
  const rides = await prisma.ride.findMany({ where: { riderId: { in: ids } }, select: { id: true } });
  await prisma.ride.deleteMany({ where: { id: { in: rides.map((r) => r.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  // "All current riders" reached rows other tests left behind too.
  await prisma.user.updateMany({ where: { earlyAccessAt: { not: null } }, data: { earlyAccessAt: null } });
  await app.close();
  await prisma.$disconnect();
});

async function person(role: "RIDER" | "DRIVER" | "ADMIN" = "RIDER", data: { isReviewDemo?: boolean } = {}) {
  const created = await createTestUser(role === "DRIVER" ? "DRIVER" : "RIDER");
  const user =
    role === "ADMIN" || data.isReviewDemo
      ? await prisma.user.update({ where: { id: created.id }, data: { role, ...data } })
      : created;
  userIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role })}` } };
}

async function book(headers: Record<string, string>) {
  const { pickup, dropoff } = await getTestZones();
  return app.inject({
    method: "POST",
    url: "/rides",
    headers,
    payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "LONE" },
  });
}

/** A countdown to `inMs` from now, set the way the admin site sets it. */
async function countdown(actor: string, inMs = 3 * 24 * 3600_000) {
  const launchAt = new Date(Date.now() + inMs);
  await setLaunchMode(prisma, actor, { mode: "COUNTDOWN", launchAt });
  return launchAt;
}

describe("GET /launch-status", () => {
  it("is OFF until launch mode is ever set, with the server's clock", async () => {
    const before = Date.now();
    const res = await app.inject({ method: "GET", url: "/launch-status" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body).toMatchObject({ mode: "OFF", launchAt: null });
    expect(Date.parse(body.serverTime)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(body.serverTime)).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("gives the launch time during a countdown, no login needed", async () => {
    const { user } = await person("ADMIN");
    const launchAt = await countdown(user.id);
    const res = await app.inject({ method: "GET", url: "/launch-status" });
    expect(res.json()).toMatchObject({ mode: "COUNTDOWN", launchAt: launchAt.toISOString() });
  });
});

describe("during the countdown", () => {
  it("refuses a normal rider's booking, in words every app version shows, and books nothing", async () => {
    const { user: admin } = await person("ADMIN");
    const { user, headers } = await person();
    await countdown(admin.id);

    const res = await book(headers);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe("LAUNCH_NOT_OPEN");
    expect(body.error).toMatch(/^CampusRide opens on \w+day \d{1,2} \w+ at \d{1,2}:\d{2} (AM|PM)\. See you then!$/);
    expect(await prisma.ride.count({ where: { riderId: user.id } })).toBe(0);

    const mine = await app.inject({ method: "GET", url: "/me/launch-status", headers });
    expect(mine.json()).toMatchObject({ mode: "COUNTDOWN", canRide: false });
  });

  it("lets an early-access rider book", async () => {
    const { user: admin } = await person("ADMIN");
    const { user, headers } = await person();
    await countdown(admin.id);
    await setEarlyAccess(prisma, admin.id, user.id, true);

    expect((await book(headers)).statusCode).toBe(201);
    const mine = await app.inject({ method: "GET", url: "/me/launch-status", headers });
    expect(mine.json()).toMatchObject({ mode: "COUNTDOWN", canRide: true });
  });

  it("lets review demo accounts and admins ride", async () => {
    const { user: admin, headers: adminHeaders } = await person("ADMIN");
    const { user: demo, headers: demoHeaders } = await person("RIDER", { isReviewDemo: true });
    await countdown(admin.id);

    await expect(assertCanBook(prisma, demo.id)).resolves.toBeUndefined();
    await expect(assertCanBook(prisma, admin.id)).resolves.toBeUndefined();
    for (const headers of [demoHeaders, adminHeaders]) {
      const res = await app.inject({ method: "GET", url: "/me/launch-status", headers });
      expect(res.json().canRide).toBe(true);
    }
  });

  it("refuses again once early access is taken away", async () => {
    const { user: admin } = await person("ADMIN");
    const { user, headers } = await person();
    await countdown(admin.id);
    await setEarlyAccess(prisma, admin.id, user.id, true);
    await setEarlyAccess(prisma, admin.id, user.id, false);
    expect((await book(headers)).statusCode).toBe(422);
  });
});

describe("launch time", () => {
  it("is LIVE by itself at launchAt: the status says so and everyone can book", async () => {
    const { user: admin } = await person("ADMIN");
    const { headers } = await person();
    const launchAt = await countdown(admin.id, 1500);

    expect((await book(headers)).statusCode).toBe(422);
    const justAfter = await launchStatus(prisma, new Date(launchAt.getTime() + 1));
    expect(justAfter).toMatchObject({ mode: "LIVE", launchAt: null });

    await new Promise((resolve) => setTimeout(resolve, launchAt.getTime() - Date.now() + 50));
    expect((await app.inject({ method: "GET", url: "/launch-status" })).json().mode).toBe("LIVE");
    expect((await book(headers)).statusCode).toBe(201);
    // Nothing rewrote the setting: it's the clock that opened it.
    expect((await prisma.launchSetting.findUniqueOrThrow({ where: { id: "launch" } })).mode).toBe("COUNTDOWN");
  });

  it("OFF and LIVE refuse nobody", async () => {
    const { user: admin } = await person("ADMIN");
    const { headers } = await person();
    await setLaunchMode(prisma, admin.id, { mode: "LIVE", launchAt: null });
    expect((await book(headers)).statusCode).toBe(201);
  });
});

describe("admin Settings", () => {
  it("sets the mode, and the audit log says who changed what", async () => {
    const { user: admin, headers } = await person("ADMIN");
    const launchAt = "2030-11-14T09:00:00.000Z";
    const res = await app.inject({
      method: "PUT",
      url: "/admin/launch",
      headers,
      payload: { mode: "COUNTDOWN", launchAt },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toMatchObject({ mode: "COUNTDOWN", launchAt });

    const live = await app.inject({ method: "PUT", url: "/admin/launch", headers, payload: { mode: "LIVE" } });
    expect(live.json().status.mode).toBe("LIVE");

    const rows = await prisma.adminAuditLog.findMany({
      where: { actor: admin.id, action: "launch.update" },
      orderBy: { timestamp: "asc" },
    });
    expect(rows.map((r) => r.reason)).toEqual([
      "OFF -> COUNTDOWN to Thursday 14 November at 9:00 AM GMT (2030-11-14T09:00:00.000Z)",
      "COUNTDOWN to Thursday 14 November at 9:00 AM GMT (2030-11-14T09:00:00.000Z) -> LIVE",
    ]);

    const read = await app.inject({ method: "GET", url: "/admin/launch", headers });
    expect(read.json().setting).toMatchObject({ mode: "LIVE", launchAt: null, updatedBy: { id: admin.id } });
  });

  it("refuses a countdown without a future launch time, and logs nothing", async () => {
    const { user: admin, headers } = await person("ADMIN");
    for (const payload of [
      { mode: "COUNTDOWN" },
      { mode: "COUNTDOWN", launchAt: "2020-01-01T00:00:00.000Z" },
      { mode: "COUNTDOWN", launchAt: "soon" },
    ]) {
      const res = await app.inject({ method: "PUT", url: "/admin/launch", headers, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id } })).toBe(0);
    expect((await launchStatus(prisma)).mode).toBe("OFF");
  });

  it("gives and takes away one rider's early access by phone number, audit-logged", async () => {
    const { user: admin, headers } = await person("ADMIN");
    const { user: rider } = await person();
    const local = `0${rider.phone.slice(4)}`;

    const look = await app.inject({ method: "GET", url: `/admin/early-access?phone=${local}`, headers });
    expect(look.json().account).toMatchObject({ id: rider.id, earlyAccessAt: null });

    const give = await app.inject({ method: "POST", url: "/admin/early-access", headers, payload: { phone: local, enabled: true } });
    expect(give.statusCode).toBe(200);
    expect(give.json().account.earlyAccessAt).not.toBeNull();
    const take = await app.inject({ method: "POST", url: "/admin/early-access", headers, payload: { phone: local, enabled: false } });
    expect(take.json().account.earlyAccessAt).toBeNull();

    const actions = await prisma.adminAuditLog.findMany({ where: { actor: admin.id, target: rider.id }, orderBy: { timestamp: "asc" } });
    expect(actions.map((a) => a.action)).toEqual(["early_access.grant", "early_access.revoke"]);
  });

  it("only gives early access to rider accounts", async () => {
    const { headers } = await person("ADMIN");
    const { user: driver } = await person("DRIVER");
    const res = await app.inject({ method: "POST", url: "/admin/early-access", headers, payload: { phone: driver.phone, enabled: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/driver account/);
  });

  it("gives every current rider early access in one go, but not drivers, demo accounts, closed accounts or later sign-ups", async () => {
    const { user: admin, headers } = await person("ADMIN");
    const { user: pilot } = await person();
    const { user: driver } = await person("DRIVER");
    const { user: demo } = await person("RIDER", { isReviewDemo: true });
    const { user: closed } = await person();
    await deleteAccount(prisma, closed.id);

    const res = await app.inject({ method: "POST", url: "/admin/early-access/all-riders", headers });
    expect(res.statusCode).toBe(200);
    const { granted, earlyAccessRiders } = res.json();
    expect(granted).toBeGreaterThanOrEqual(1);
    expect(earlyAccessRiders).toBeGreaterThanOrEqual(granted);

    const { user: later } = await person();
    const access = Object.fromEntries(
      (
        await prisma.user.findMany({
          where: { id: { in: [pilot.id, driver.id, demo.id, closed.id, later.id] } },
          select: { id: true, earlyAccessAt: true },
        })
      ).map((u) => [u.id, u.earlyAccessAt !== null]),
    );
    expect(access).toEqual({ [pilot.id]: true, [driver.id]: false, [demo.id]: false, [closed.id]: false, [later.id]: false });

    const row = await prisma.adminAuditLog.findFirstOrThrow({ where: { actor: admin.id, action: "early_access.grant_all" } });
    expect(row.reason).toBe(`${granted} rider account(s) given early access`);
  });
});
