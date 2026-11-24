/**
 * Service hours. Pins:
 *   1. GET /app/config and GET /me/service-status say whether riders can book;
 *   2. outside service hours (or Close now) POST /rides is refused with words
 *      every app build shows — 422 { code, error, nextOpenAt }, never a 409
 *      (old builds take any 409 for "you already have a ride") — and books nothing;
 *   3. with no driver online (switch on) it is refused with NO_DRIVERS_ONLINE;
 *   4. requests already searching are untouched when CampusRide closes;
 *   5. review demo accounts and admins always book; launch mode's countdown
 *      still comes first;
 *   6. every admin change is in the audit log;
 *   7. "Notify me": one "We're open!" push per rider at the opening, then the
 *      list is empty (a second check sends nothing);
 *   8. state changes go to the apps over the socket, once per change.
 * The schedule maths itself (edges, overnight, closed days, override
 * expiry, Africa/Accra) is pinned in @rida/shared service/serviceHours.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  DEFAULT_WEEKLY_SCHEDULE,
  NO_DRIVERS_TEXT,
  SERVICE_OPEN_PUSH_TEXT,
  type WeeklySchedule,
} from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerServiceHoursRoutes } from "./serviceHours";
import { registerAppVersionRoutes } from "./appVersion";
import { signAccessToken } from "../services/auth/tokens";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import {
  assertServiceOpen,
  clearServiceHoursCache,
  serviceStatus,
  setServiceHoursGateForTests,
} from "../services/service/serviceHours";
import {
  resetServiceAnnouncerForTests,
  serviceTick,
  settleServiceAnnouncementsForTests,
} from "../services/service/serviceAnnouncer";
import { clearLaunchCache, setLaunchMode } from "../services/launch/launchSettings";
import { resetPushStateForTests, setPushTransportForTests } from "../services/push/pushService";
import { settleBroadcastsForTests } from "../services/push/broadcast";
import { fakeTransport, newToken } from "../services/push/testFixtures";

const mockEmits = vi.hoisted(() => [] as unknown[]);
vi.mock("../realtime/rideSocket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../realtime/rideSocket")>()),
  emitServiceStatus: (payload: unknown) => mockEmits.push(payload),
}));

const ALL_DAY: WeeklySchedule = Array.from({ length: 7 }, () => ({ open: "00:00", close: "24:00" }));
const NEVER: WeeklySchedule = Array.from({ length: 7 }, () => null);

let app: FastifyInstance;
const userIds: string[] = [];
let admin: Awaited<ReturnType<typeof person>>;

beforeAll(async () => {
  setServiceHoursGateForTests(true);
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerServiceHoursRoutes(app, prisma);
  registerAppVersionRoutes(app, undefined, undefined, () => serviceStatus(prisma));
  await app.ready();
});

beforeEach(async () => {
  // No driver online but the ones a test puts there (rows other test files left behind are taken offline).
  await prisma.driver.updateMany({ where: { isOnline: true }, data: { isOnline: false } });
  await prisma.serviceHoursSetting.deleteMany({});
  await prisma.serviceOpenWaiter.deleteMany({});
  clearServiceHoursCache();
  resetServiceAnnouncerForTests();
  mockEmits.length = 0;
  admin = await person("ADMIN");
});

afterEach(async () => {
  setPushTransportForTests(null);
  resetPushStateForTests();
  await prisma.serviceHoursSetting.deleteMany({});
  await prisma.launchSetting.deleteMany({});
  clearServiceHoursCache();
  clearLaunchCache();
  const ids = userIds.splice(0);
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actor: { in: ids } }, { actor: "system", action: "notification.opening" }] } });
  await prisma.broadcast.deleteMany({ where: { kind: "OPENING" } });
  const rides = await prisma.ride.findMany({ where: { riderId: { in: ids } }, select: { id: true } });
  await prisma.ride.deleteMany({ where: { id: { in: rides.map((r) => r.id) } } });
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  setServiceHoursGateForTests(false);
  await app.close();
  await prisma.$disconnect();
});

async function person(role: "RIDER" | "ADMIN" = "RIDER", data: { isReviewDemo?: boolean } = {}) {
  const created = await createTestUser("RIDER");
  const user =
    role === "ADMIN" || data.isReviewDemo
      ? await prisma.user.update({ where: { id: created.id }, data: { role, ...data } })
      : created;
  userIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role })}` } };
}

async function onlineDriver() {
  const { user } = await createTestDriver({ isOnline: true });
  userIds.push(user.id);
  return user;
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

async function saveHours(weekly: WeeklySchedule, extra: { closedMessage?: string | null; blockWhenNoDrivers?: boolean } = {}) {
  const res = await app.inject({
    method: "PUT",
    url: "/admin/service-hours",
    headers: admin.headers,
    payload: { weekly, closedMessage: extra.closedMessage ?? null, blockWhenNoDrivers: extra.blockWhenNoDrivers ?? true },
  });
  expect(res.statusCode, res.body).toBe(200);
  await settleServiceAnnouncementsForTests();
}

async function override(mode: "OPEN" | "CLOSED" | null) {
  const res = await app.inject({
    method: "PUT",
    url: "/admin/service-hours/override",
    headers: admin.headers,
    payload: { mode },
  });
  expect(res.statusCode, res.body).toBe(200);
  // The route also tells the apps (and may send "We're open!") in the background.
  await settleServiceAnnouncementsForTests();
}

/**
 * What every rider app build already in phones does with a refused POST
 * /rides (packages/mobile-shared rides/api.ts createRide before this
 * change): a 409 is "you already have a ride in progress"; a 400/404/422
 * with string `code` and `error` shows `error` as the server wrote it.
 */
function oldAppShows(res: { statusCode: number; json: () => Record<string, unknown> }): string {
  if (res.statusCode === 409) return "You already have a ride in progress";
  const data = res.json();
  if ([400, 404, 422].includes(res.statusCode) && typeof data.code === "string" && typeof data.error === "string") {
    return data.error;
  }
  return "Couldn't request a ride. Please check your connection and try again.";
}

describe("riders can't book when CampusRide is closed", () => {
  it("refuses outside service hours with when it's back, in words old app builds show", async () => {
    await saveHours(DEFAULT_WEEKLY_SCHEDULE);
    await onlineDriver();
    await override("CLOSED");
    const rider = await person();

    const res = await book(rider.headers);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.code).toBe("SERVICE_CLOSED");
    expect(typeof body.nextOpenAt).toBe("string");
    expect(body.error).toMatch(/^CampusRide is closed\. We're back (at|on) .+\.$/);
    expect(oldAppShows(res)).toBe(body.error);
    expect(await prisma.ride.count({ where: { riderId: rider.user.id } })).toBe(0);
  });

  it("uses the custom closed message", async () => {
    await saveHours(NEVER, { closedMessage: "Closed for the holiday" });
    const res = await book((await person()).headers);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "SERVICE_CLOSED", error: "Closed for the holiday.", nextOpenAt: null });
  });

  it("refuses in open hours when no driver is online, and books once one is", async () => {
    await saveHours(ALL_DAY);
    const rider = await person();

    const res = await book(rider.headers);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "NO_DRIVERS_ONLINE", error: NO_DRIVERS_TEXT, nextOpenAt: null });
    expect(oldAppShows(res)).toBe(NO_DRIVERS_TEXT);

    await onlineDriver();
    expect((await book(rider.headers)).statusCode).toBe(201);
  });

  it("books with no driver online when the switch is off", async () => {
    await saveHours(ALL_DAY, { blockWhenNoDrivers: false });
    expect((await book((await person()).headers)).statusCode).toBe(201);
  });

  it("books during open hours (Open now), and the defaults apply before anything is saved", async () => {
    await onlineDriver();
    await override("OPEN");
    expect((await book((await person()).headers)).statusCode).toBe(201);
    expect((await prisma.serviceHoursSetting.findUniqueOrThrow({ where: { id: "service" } })).weekly).toEqual(
      DEFAULT_WEEKLY_SCHEDULE,
    );
  });
});

describe("what is never blocked", () => {
  it("leaves a request already searching alone when CampusRide closes", async () => {
    await saveHours(ALL_DAY);
    await onlineDriver();
    const rider = await person();
    const created = await book(rider.headers);
    expect(created.statusCode).toBe(201);
    const rideId = created.json().ride.id as string;

    await override("CLOSED");
    await serviceTick(prisma);
    await prisma.driver.updateMany({ where: { userId: { in: userIds } }, data: { isOnline: false } });
    await serviceTick(prisma);

    const ride = await prisma.ride.findUniqueOrThrow({ where: { id: rideId } });
    expect(ride.status).toBe("REQUESTED");
    expect(ride.cancelledAt).toBeNull();
    const active = await app.inject({ method: "GET", url: "/rides/active", headers: rider.headers });
    expect(active.json().ride?.id ?? active.json().id).toBe(rideId);
  });

  it("lets review demo accounts and admins book whatever the hours", async () => {
    await saveHours(NEVER);
    const demo = await person("RIDER", { isReviewDemo: true });
    expect((await book(demo.headers)).statusCode).toBe(201);
    // Admins can't book from the rider app (POST /rides is riders only), but the gate never refuses them.
    await expect(assertServiceOpen(prisma, admin.user.id)).resolves.toBeUndefined();
    await expect(assertServiceOpen(prisma, (await person()).user.id)).rejects.toThrow("CampusRide is closed");

    const mine = await app.inject({ method: "GET", url: "/me/service-status", headers: demo.headers });
    expect(mine.json()).toMatchObject({ open: false, reason: "SCHEDULE", exempt: true });
  });

  it("keeps launch mode's countdown first, and review demo accounts still book during both", async () => {
    await saveHours(NEVER);
    await setLaunchMode(prisma, admin.user.id, { mode: "COUNTDOWN", launchAt: new Date(Date.now() + 86_400_000) });
    const rider = await person();
    const res = await book(rider.headers);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("LAUNCH_NOT_OPEN");

    const demo = await person("RIDER", { isReviewDemo: true });
    expect((await book(demo.headers)).statusCode).toBe(201);
  });
});

describe("what the apps are told", () => {
  it("puts the state in GET /app/config and GET /me/service-status", async () => {
    await saveHours(NEVER, { closedMessage: "Closed for the holiday" });
    const config = await app.inject({ method: "GET", url: "/app/config" });
    expect(config.statusCode).toBe(200);
    expect(config.json().supportPhone).toMatch(/^\+233/);
    expect(config.json().service).toMatchObject({
      open: false,
      reason: "SCHEDULE",
      nextOpenAt: null,
      message: "Closed for the holiday",
      today: null,
    });

    const rider = await person();
    const mine = await app.inject({ method: "GET", url: "/me/service-status", headers: rider.headers });
    expect(mine.json()).toMatchObject({ open: false, exempt: false, notifyMe: false });
  });

  it("announces a change over the socket once, and again only when something changes", async () => {
    await saveHours(ALL_DAY);
    await onlineDriver();
    mockEmits.length = 0;
    resetServiceAnnouncerForTests();

    await serviceTick(prisma);
    await serviceTick(prisma);
    expect(mockEmits).toHaveLength(1);
    expect(mockEmits[0]).toMatchObject({ open: true, reason: "SCHEDULE" });

    await override("CLOSED");
    await serviceTick(prisma);
    expect(mockEmits.at(-1)).toMatchObject({ open: false, reason: "MANUAL" });
  });
});

describe("admin Settings", () => {
  it("shows the state in force and writes every change to the audit log", async () => {
    await saveHours(DEFAULT_WEEKLY_SCHEDULE, { closedMessage: "Closed for the holiday" });
    await override("CLOSED");
    await override(null);

    const res = await app.inject({ method: "GET", url: "/admin/service-hours", headers: admin.headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.setting).toMatchObject({
      weekly: DEFAULT_WEEKLY_SCHEDULE,
      override: null,
      closedMessage: "Closed for the holiday",
      blockWhenNoDrivers: true,
      updatedBy: { id: admin.user.id },
    });
    expect(body.stateLine).toMatch(/^(Open|Closed|Open hours)/);

    const audit = await prisma.adminAuditLog.findMany({
      where: { actor: admin.user.id },
      orderBy: { timestamp: "asc" },
      select: { action: true, reason: true },
    });
    expect(audit.map((a) => a.action)).toEqual([
      "service_hours.update",
      "service_hours.override",
      "service_hours.override",
    ]);
    expect(audit[0]!.reason).toContain("Mon 08:00-17:00");
    expect(audit[0]!.reason).toContain('message "Closed for the holiday"');
    expect(audit[1]!.reason).toMatch(/follow the schedule -> Close now until /);
    expect(audit[2]!.reason).toMatch(/-> follow the schedule$/);
  });

  it("refuses a schedule that doesn't make sense, and riders and drivers", async () => {
    const bad = DEFAULT_WEEKLY_SCHEDULE.map((d, i) => (i === 3 ? { open: "09:00", close: "09:00" } : d));
    const res = await app.inject({
      method: "PUT",
      url: "/admin/service-hours",
      headers: admin.headers,
      payload: { weekly: bad, closedMessage: null, blockWhenNoDrivers: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Wednesday");

    const rider = await person();
    const asRider = await app.inject({ method: "PUT", url: "/admin/service-hours/override", headers: rider.headers, payload: { mode: "OPEN" } });
    expect(asRider.statusCode).toBe(403);
  });
});

describe("Notify me when you open", () => {
  it("sends one 'We're open!' push per rider at the opening, then empties the list", async () => {
    const fake = fakeTransport();
    setPushTransportForTests(fake.transport);
    await saveHours(ALL_DAY);
    await override("CLOSED");
    const rider = await person();
    await prisma.pushToken.create({ data: { userId: rider.user.id, token: newToken(), app: "rider", platform: "ios" } });

    // Twice: still one row, one push.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "POST", url: "/me/service-notify", headers: rider.headers });
      expect(res.json()).toEqual({ notifyMe: true });
    }
    expect((await app.inject({ method: "GET", url: "/me/service-status", headers: rider.headers })).json().notifyMe).toBe(true);

    // Still closed: nothing goes out.
    await serviceTick(prisma);
    expect(fake.sent).toHaveLength(0);

    await onlineDriver();
    // Back to the schedule: open. The route's own check sends it (no need to wait for the timer).
    await override(null);
    await settleBroadcastsForTests();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ title: SERVICE_OPEN_PUSH_TEXT.title, body: SERVICE_OPEN_PUSH_TEXT.body });
    expect(await prisma.serviceOpenWaiter.count()).toBe(0);

    // The next check (another server, the next tick): nothing more.
    await serviceTick(prisma);
    await settleBroadcastsForTests();
    expect(fake.sent).toHaveLength(1);
    expect(await prisma.broadcast.count({ where: { kind: "OPENING" } })).toBe(1);
  });

  it("is refused while riders can book, and can be undone", async () => {
    await saveHours(ALL_DAY, { blockWhenNoDrivers: false });
    const rider = await person();
    expect((await app.inject({ method: "POST", url: "/me/service-notify", headers: rider.headers })).statusCode).toBe(409);

    await override("CLOSED");
    await app.inject({ method: "POST", url: "/me/service-notify", headers: rider.headers });
    const off = await app.inject({ method: "DELETE", url: "/me/service-notify", headers: rider.headers });
    expect(off.json()).toEqual({ notifyMe: false });
    expect(await prisma.serviceOpenWaiter.count()).toBe(0);
  });
});
