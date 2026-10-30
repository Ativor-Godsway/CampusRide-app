/**
 * Admin notifications (services/push/broadcast.ts) and the launch push. Pins:
 *   1. only admins can see, count or send anything;
 *   2. each audience reaches exactly its own installs — never another app's,
 *      a closed account's or a review demo account's;
 *   3. the caps: 5 sends to "all" audiences an hour, counted from history;
 *   4. the launch push goes out once ever: not again after a restart, nor
 *      when Live is switched off and on;
 *   5. every send is in the audit log, with the text and no full number;
 *   6. batches, dead-token cleanup, and no tokens or numbers in the logs.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ExpoPushMessage } from "expo-server-sdk";
import { BROADCAST_TITLE_MAX, LAUNCH_PUSH_TEXT } from "@rida/shared";
import { prisma } from "../db/prisma";
import { logger } from "../lib/logger";
import { registerLaunchRoutes } from "./launch";
import { registerNotificationRoutes } from "./notifications";
import { signAccessToken } from "../services/auth/tokens";
import { createTestUser } from "../services/ride/testFixtures";
import { clearLaunchCache, setLaunchMode } from "../services/launch/launchSettings";
import { checkPushReceipts, resetPushStateForTests, setPushTransportForTests } from "../services/push/pushService";
import {
  BATCH_SIZE,
  BROADCAST_CAP,
  maybeSendLaunchPush,
  resetLaunchPushForTests,
  settleBroadcastsForTests,
} from "../services/push/broadcast";
import { fakeTransport, newToken } from "../services/push/testFixtures";

let app: FastifyInstance;
let fake: ReturnType<typeof fakeTransport>;
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerLaunchRoutes(app, prisma);
  registerNotificationRoutes(app, prisma);
  await app.ready();
});

beforeEach(() => {
  resetPushStateForTests();
  resetLaunchPushForTests();
  fake = fakeTransport();
  setPushTransportForTests(fake.transport);
});

afterEach(async () => {
  await settleBroadcastsForTests();
  vi.restoreAllMocks();
  await prisma.broadcast.deleteMany({});
  await prisma.launchSetting.deleteMany({});
  clearLaunchCache();
  const ids = userIds.splice(0);
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ actor: { in: [...ids, "system"] } }, { target: { in: ids } }] },
  });
  await prisma.pushToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

afterAll(async () => {
  setPushTransportForTests(null);
  await app.close();
  await prisma.$disconnect();
});

async function person(
  role: "RIDER" | "DRIVER" | "ADMIN",
  data: { isReviewDemo?: boolean; deletedAt?: Date } = {},
) {
  const created = await createTestUser(role === "DRIVER" ? "DRIVER" : "RIDER");
  const user =
    role === "ADMIN" || Object.keys(data).length > 0
      ? await prisma.user.update({ where: { id: created.id }, data: { role, ...data } })
      : created;
  userIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role })}` } };
}

/** Registers an install of `app` for this user; returns its token. */
async function install(userId: string, appName: "rider" | "driver") {
  const token = newToken();
  await prisma.pushToken.create({ data: { userId, token, app: appName, platform: "android" } });
  return token;
}

const TEXT = { title: "Exam week", body: "Rides run until midnight all week." };

function send(headers: Record<string, string>, payload: object) {
  return app.inject({ method: "POST", url: "/admin/notifications", headers, payload });
}

function sentTo(): Set<string> {
  return new Set(fake.sent.map((m: ExpoPushMessage) => String(m.to)));
}

/** The installs of every audience: one each, plus the ones no send may reach. */
async function cast() {
  const rider = await person("RIDER");
  const driver = await person("DRIVER");
  const demo = await person("RIDER", { isReviewDemo: true });
  const closed = await person("RIDER", { deletedAt: new Date() });
  const admin = await person("ADMIN");
  return {
    admin,
    rider,
    driver,
    riderToken: await install(rider.user.id, "rider"),
    driverToken: await install(driver.user.id, "driver"),
    demoToken: await install(demo.user.id, "rider"),
    closedToken: await install(closed.user.id, "rider"),
    // A rider token filed under the driver app must not reach riders (app decides).
    strayToken: await install(rider.user.id, "driver"),
  };
}

describe("only admins", () => {
  it("refuses riders, drivers and nobody on every notification route", async () => {
    const rider = await person("RIDER");
    const driver = await person("DRIVER");
    const routes = [
      { method: "GET" as const, url: "/admin/notifications" },
      { method: "GET" as const, url: "/admin/notifications/audience?audience=RIDERS" },
      { method: "POST" as const, url: "/admin/notifications", payload: { audience: "RIDERS", ...TEXT } },
      { method: "POST" as const, url: "/admin/notifications/test", payload: TEXT },
      { method: "PUT" as const, url: "/admin/launch/push", payload: { enabled: true } },
    ];
    for (const route of routes) {
      expect((await app.inject(route)).statusCode).toBe(401);
      for (const who of [rider, driver]) {
        expect((await app.inject({ ...route, headers: who.headers })).statusCode).toBe(403);
      }
    }
    await settleBroadcastsForTests();
    expect(fake.sent).toHaveLength(0);
    expect(await prisma.broadcast.count()).toBe(0);
  });
});

describe("audiences", () => {
  it("all riders: rider app installs of open, real rider accounts only", async () => {
    const c = await cast();
    const preview = await app.inject({
      method: "GET",
      url: "/admin/notifications/audience?audience=RIDERS",
      headers: c.admin.headers,
    });
    const res = await send(c.admin.headers, { audience: "RIDERS", ...TEXT });
    expect(res.statusCode).toBe(202);
    await settleBroadcastsForTests();

    const to = sentTo();
    expect(to.has(c.riderToken)).toBe(true);
    for (const t of [c.driverToken, c.demoToken, c.closedToken, c.strayToken]) expect(to.has(t)).toBe(false);
    // The confirm box's number is what was sent.
    expect(preview.json().devices).toBe(fake.sent.length);
    const row = await prisma.broadcast.findUniqueOrThrow({ where: { id: res.json().broadcast.id } });
    expect(row).toMatchObject({ kind: "RIDERS", status: "SENT", devices: fake.sent.length, delivered: fake.sent.length, failed: 0 });
    expect(fake.sent[0]).toMatchObject({ title: TEXT.title, body: TEXT.body, data: { kind: "ANNOUNCEMENT" } });
  });

  it("all drivers, and everyone", async () => {
    const c = await cast();
    await send(c.admin.headers, { audience: "DRIVERS", ...TEXT });
    await settleBroadcastsForTests();
    let to = sentTo();
    expect(to.has(c.driverToken)).toBe(true);
    for (const t of [c.riderToken, c.demoToken, c.closedToken, c.strayToken]) expect(to.has(t)).toBe(false);
    // The driver app's own Android channel.
    expect(fake.sent.find((m) => m.to === c.driverToken)?.channelId).toBe("ride-requests");

    fake.sent.length = 0;
    await send(c.admin.headers, { audience: "EVERYONE", ...TEXT });
    await settleBroadcastsForTests();
    to = sentTo();
    expect(to.has(c.riderToken) && to.has(c.driverToken)).toBe(true);
    for (const t of [c.demoToken, c.closedToken, c.strayToken]) expect(to.has(t)).toBe(false);
  });

  it("one phone number: that account's installs, in any spelling of the number", async () => {
    const c = await cast();
    const other = await install(c.rider.user.id, "rider");
    const local = `0${c.rider.user.phone.slice(4)}`;
    const preview = await app.inject({
      method: "GET",
      url: `/admin/notifications/audience?audience=PHONE&phone=${local}`,
      headers: c.admin.headers,
    });
    expect(preview.json()).toMatchObject({ devices: 2, recipient: { role: "RIDER" } });
    expect(preview.json().recipient.maskedPhone).not.toContain(c.rider.user.phone.slice(4, 9));

    const res = await send(c.admin.headers, { audience: "PHONE", phone: local, ...TEXT });
    expect(res.statusCode).toBe(202);
    await settleBroadcastsForTests();
    expect(sentTo()).toEqual(new Set([c.riderToken, other]));
  });

  it("one phone number: says so for a number with no account, an admin's, or none at all", async () => {
    const c = await cast();
    expect((await send(c.admin.headers, { audience: "PHONE", phone: "0200000001", ...TEXT })).statusCode).toBe(404);
    const toAdmin = await send(c.admin.headers, { audience: "PHONE", phone: c.admin.user.phone, ...TEXT });
    expect(toAdmin.statusCode).toBe(400);
    expect((await send(c.admin.headers, { audience: "PHONE", ...TEXT })).statusCode).toBe(400);
    expect(fake.sent).toHaveLength(0);
  });

  it("refuses text over the limits, with the limit in words", async () => {
    const { headers } = await person("ADMIN");
    const res = await send(headers, { audience: "RIDERS", title: "x".repeat(BROADCAST_TITLE_MAX + 1), body: "b" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(String(BROADCAST_TITLE_MAX));
    expect(await prisma.broadcast.count()).toBe(0);
  });
});

describe("send test to me", () => {
  it("sends nothing to an admin's number and says why", async () => {
    const c = await cast();
    const res = await app.inject({ method: "POST", url: "/admin/notifications/test", headers: c.admin.headers, payload: TEXT });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ devices: 0, delivered: 0 });
    expect(res.json().message).toContain("one account per phone number");
    expect(fake.sent).toHaveLength(0);
    expect(await prisma.broadcast.findFirstOrThrow({ where: { kind: "TEST" } })).toMatchObject({ devices: 0, status: "SENT" });
  });
});

describe("the cap", () => {
  it("allows 5 sends to everyone-style audiences an hour, then refuses with the wait", async () => {
    const { headers } = await person("ADMIN");
    // Older than an hour: no longer counts.
    await prisma.broadcast.create({
      data: { actor: "x", kind: "EVERYONE", title: "Old", body: "Old", status: "SENT", createdAt: new Date(Date.now() - 61 * 60_000) },
    });
    for (let i = 0; i < BROADCAST_CAP.max; i++) {
      expect((await send(headers, { audience: i % 2 ? "DRIVERS" : "RIDERS", ...TEXT })).statusCode).toBe(202);
    }
    const refused = await send(headers, { audience: "EVERYONE", ...TEXT });
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(50 * 60);
    expect(refused.json().error).toContain("At most 5");
    expect(await prisma.broadcast.count({ where: { createdAt: { gt: new Date(Date.now() - 3600_000) } } })).toBe(BROADCAST_CAP.max);

    // One number and tests have their own allowance.
    const history = await app.inject({ method: "GET", url: "/admin/notifications", headers });
    expect(history.json().caps).toEqual({ broadcast: { used: 5, max: 5 }, direct: { used: 0, max: 10 } });
    expect((await app.inject({ method: "POST", url: "/admin/notifications/test", headers, payload: TEXT })).statusCode).toBe(200);
  });

  it("holds when sends arrive at the same moment", async () => {
    const { headers } = await person("ADMIN");
    const results = await Promise.all(
      Array.from({ length: BROADCAST_CAP.max + 3 }, () => send(headers, { audience: "DRIVERS", ...TEXT })),
    );
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(BROADCAST_CAP.max);
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(3);
  });
});

describe("audit log and history", () => {
  it("records every send with who, the audience and the text, never the full number", async () => {
    const c = await cast();
    const res = await send(c.admin.headers, { audience: "PHONE", phone: c.rider.user.phone, ...TEXT });
    await settleBroadcastsForTests();
    const id = res.json().broadcast.id;
    const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { target: id } });
    expect(audit).toMatchObject({ actor: c.admin.user.id, action: "notification.send" });
    expect(audit.reason).toContain(TEXT.title);
    expect(audit.reason).toContain(TEXT.body);
    expect(audit.reason).toContain(`+233*****${c.rider.user.phone.slice(-3)}`);
    expect(audit.reason).not.toContain(c.rider.user.phone);

    await app.inject({ method: "POST", url: "/admin/notifications/test", headers: c.admin.headers, payload: TEXT });
    expect(await prisma.adminAuditLog.count({ where: { actor: c.admin.user.id, action: "notification.test" } })).toBe(1);

    const history = (await app.inject({ method: "GET", url: "/admin/notifications", headers: c.admin.headers })).json();
    expect(history.broadcasts[0]).toMatchObject({ kind: "TEST", sentBy: { id: c.admin.user.id } });
    expect(history.broadcasts[1]).toMatchObject({
      id,
      kind: "PHONE",
      audienceLabel: "One phone number",
      title: TEXT.title,
      devices: 1,
      delivered: 1,
      failed: 0,
      status: "SENT",
      sentBy: { id: c.admin.user.id, name: c.admin.user.name },
    });
    expect(JSON.stringify(history)).not.toContain(c.rider.user.phone);
    expect(JSON.stringify(history)).not.toContain("ExponentPushToken");
  });
});

describe("delivery", () => {
  it("sends in batches, removes installs Expo reports dead, and logs no tokens or numbers", async () => {
    const c = await cast();
    const many = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => ({
      userId: c.rider.user.id,
      token: `ExponentPushToken[batch-${i}-${Date.now()}]`,
      app: "rider",
      platform: "android",
    }));
    await prisma.pushToken.createMany({ data: many });
    const batches: number[] = [];
    const realSend = fake.transport.send;
    fake.transport.send = async (messages) => {
      batches.push(messages.length);
      return realSend(messages);
    };
    const receiptIds: string[] = [];
    fake.setTickets((m, i) => {
      if (m.to === c.riderToken)
        return { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } };
      receiptIds.push(`r-${batches.length}-${i}`);
      return { status: "ok", id: receiptIds[receiptIds.length - 1]! };
    });
    const logged: unknown[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => void logged.push(args));
    }

    const res = await send(c.admin.headers, { audience: "RIDERS", ...TEXT });
    await settleBroadcastsForTests();

    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThanOrEqual(BATCH_SIZE);
    expect(await prisma.pushToken.findUnique({ where: { token: c.riderToken } })).toBeNull();
    const row = await prisma.broadcast.findUniqueOrThrow({ where: { id: res.json().broadcast.id } });
    expect(row.failed).toBe(1);
    expect(row.delivered).toBe(row.devices - 1);

    // A late failure (the receipt) moves one from delivered to failed.
    fake.receiptsById[receiptIds[0]!] = { status: "error", message: "x", details: { error: "MessageRateExceeded" } };
    await checkPushReceipts(prisma, Date.now() + 16 * 60_000);
    expect(await prisma.broadcast.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      delivered: row.delivered - 1,
      failed: 2,
    });

    const text = JSON.stringify(logged);
    expect(text).not.toContain("PushToken[");
    expect(text).not.toContain(c.rider.user.phone);
  });

  it("refuses to send while push is switched off", async () => {
    setPushTransportForTests(null);
    const { headers } = await person("ADMIN");
    expect((await send(headers, { audience: "RIDERS", ...TEXT })).statusCode).toBe(503);
    expect(await prisma.broadcast.count()).toBe(0);
  });
});

describe("the launch push", () => {
  function putLaunch(headers: Record<string, string>, payload: object) {
    return app.inject({ method: "PUT", url: "/admin/launch", headers, payload });
  }
  function launchSent() {
    return fake.sent.filter((m) => m.title === LAUNCH_PUSH_TEXT.title);
  }

  it("is off by default: going Live sends nothing", async () => {
    const c = await cast();
    expect((await putLaunch(c.admin.headers, { mode: "LIVE" })).statusCode).toBe(200);
    await settleBroadcastsForTests();
    expect(launchSent()).toHaveLength(0);
    const settings = await app.inject({ method: "GET", url: "/admin/launch", headers: c.admin.headers });
    expect(settings.json().launchPush).toEqual({ enabled: false, sent: null });
  });

  it("goes to riders once when switched to Live — never again, restarts and Live off/on included", async () => {
    const c = await cast();
    await setLaunchMode(prisma, c.admin.user.id, { mode: "COUNTDOWN", launchAt: new Date(Date.now() + 86_400_000) });
    const on = await app.inject({ method: "PUT", url: "/admin/launch/push", headers: c.admin.headers, payload: { enabled: true } });
    expect(on.json().launchPush).toEqual({ enabled: true, sent: null });

    await putLaunch(c.admin.headers, { mode: "LIVE" });
    await settleBroadcastsForTests();
    const first = launchSent();
    expect(first.map((m) => m.to)).toContain(c.riderToken);
    for (const t of [c.driverToken, c.demoToken, c.closedToken, c.strayToken]) {
      expect(first.map((m) => m.to)).not.toContain(t);
    }
    expect(first[0]).toMatchObject({ body: LAUNCH_PUSH_TEXT.body });

    // A restart (the in-memory flag is gone), Live off and on, the timer ticking.
    resetLaunchPushForTests();
    expect(await maybeSendLaunchPush(prisma)).toBe(false);
    await putLaunch(c.admin.headers, { mode: "OFF" });
    resetLaunchPushForTests();
    await putLaunch(c.admin.headers, { mode: "LIVE" });
    resetLaunchPushForTests();
    await Promise.all([maybeSendLaunchPush(prisma), maybeSendLaunchPush(prisma)]);
    await settleBroadcastsForTests();
    expect(launchSent()).toHaveLength(first.length);
    expect(await prisma.broadcast.count({ where: { kind: "LAUNCH" } })).toBe(1);

    const audit = await prisma.adminAuditLog.findMany({
      where: { OR: [{ actor: c.admin.user.id, action: { startsWith: "launch.push" } }, { action: "notification.launch" }] },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(["launch.push.enable", "notification.launch"]);

    // It can't be switched on again afterwards.
    const again = await app.inject({ method: "PUT", url: "/admin/launch/push", headers: c.admin.headers, payload: { enabled: true } });
    expect(again.statusCode).toBe(409);
    const settings = await app.inject({ method: "GET", url: "/admin/launch", headers: c.admin.headers });
    expect(settings.json().launchPush.sent).toMatchObject({ kind: "LAUNCH", sentBy: null });
  });

  it("goes out when a countdown reaches its time by itself", async () => {
    const c = await cast();
    const launchAt = new Date(Date.now() + 60_000);
    await setLaunchMode(prisma, c.admin.user.id, { mode: "COUNTDOWN", launchAt });
    await app.inject({ method: "PUT", url: "/admin/launch/push", headers: c.admin.headers, payload: { enabled: true } });

    expect(await maybeSendLaunchPush(prisma)).toBe(false);
    expect(await maybeSendLaunchPush(prisma, new Date(launchAt.getTime() + 1000))).toBe(true);
    await settleBroadcastsForTests();
    expect(launchSent().map((m) => m.to)).toContain(c.riderToken);
  });

  it("can't be switched on once CampusRide is already Live", async () => {
    const { headers, user } = await person("ADMIN");
    await setLaunchMode(prisma, user.id, { mode: "LIVE", launchAt: null });
    const res = await app.inject({ method: "PUT", url: "/admin/launch/push", headers, payload: { enabled: true } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already Live");
  });
});
