/**
 * Taking a driver offline after losing touch with their phone. Pins:
 *   1. only an app that said "foreground", with no socket connected and
 *      nothing heard for the timeout (30 minutes by default), is silent;
 *      background, connected and never-announced apps never are;
 *   2. a silent driver goes offline (no zone), their session ends TIMEOUT at
 *      the last contact, and they get the push in the owner's words;
 *   3. a driver mid-trip is never taken offline; one already offline is left alone;
 *   4. their app's next presence hears "taken offline" — until they go online again.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { config } from "../../config";
import { createTestDriver, createTestRide, cleanupRide } from "../ride/testFixtures";
import { openDriverSession } from "../stats/driverSessions";
import { resetPushStateForTests, setPushTransportForTests } from "../push/pushService";
import { fakeTransport, newToken } from "../push/testFixtures";
import {
  driverHeard,
  driverSaidPresence,
  driverSocketConnected,
  driverSocketDisconnected,
  resetDriverPresenceForTests,
  silentDrivers,
  takeSilentDriversOffline,
  wasTakenOffline,
} from "./driverPresence";

const MIN = 60_000;
const TIMEOUT = config.driverSilenceTimeoutMinutes * MIN;
const userIds: string[] = [];
const rideIds: string[] = [];
let fake: ReturnType<typeof fakeTransport>;

beforeEach(() => {
  resetDriverPresenceForTests();
  resetPushStateForTests();
  fake = fakeTransport();
  setPushTransportForTests(fake.transport);
});
afterEach(async () => {
  while (rideIds.length) await cleanupRide(rideIds.pop()!);
  const ids = userIds.splice(0);
  await prisma.driver.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(() => setPushTransportForTests(null));

async function onlineDriver() {
  const { pickup } = await import("../ride/testFixtures").then((m) => m.getTestZones());
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: pickup.id });
  userIds.push(user.id);
  const token = newToken();
  await prisma.pushToken.create({ data: { userId: user.id, token, app: "driver", platform: "android" } });
  return { user, token };
}

/** The app opened in front, then its phone went quiet `ago` ms before `now`. */
function wentQuiet(userId: string, now: number, ago: number, state: "foreground" | "background" = "foreground") {
  driverSocketConnected(userId, now - ago - 1000);
  driverSaidPresence(userId, state, now - ago - 1000);
  driverSocketDisconnected(userId, now - ago);
}

describe("who is silent", () => {
  it("defaults to 30 minutes (DRIVER_SILENCE_TIMEOUT_MIN)", () => {
    expect(config.driverSilenceTimeoutMinutes).toBe(30);
  });

  it("only an app last in front, with no connection, quiet for the whole timeout", () => {
    const now = Date.now();
    wentQuiet("front-long", now, TIMEOUT);
    wentQuiet("front-short", now, TIMEOUT - MIN);
    wentQuiet("background", now, 10 * TIMEOUT, "background");
    // Never announced (an app from before presence): never.
    driverSocketConnected("old-app", now - 10 * TIMEOUT);
    driverSocketDisconnected("old-app", now - 10 * TIMEOUT);
    // Still connected (Android in the background keeps its socket): never.
    driverSocketConnected("connected", now - 10 * TIMEOUT);
    driverSaidPresence("connected", "foreground", now - 10 * TIMEOUT);
    // A position counts as contact.
    wentQuiet("positions", now, 10 * TIMEOUT);
    driverHeard("positions", now - MIN);
    expect(silentDrivers(now).map((s) => s.userId)).toEqual(["front-long"]);
  });

  it("an app that goes to the background after being quiet in front is no longer silent", () => {
    const now = Date.now();
    wentQuiet("d", now, TIMEOUT);
    driverSaidPresence("d", "background", now);
    expect(silentDrivers(now + TIMEOUT)).toEqual([]);
  });
});

describe("taking a silent driver offline", () => {
  it("offline, no zone, session ended TIMEOUT at the last contact, and the push", async () => {
    const d = await onlineDriver();
    const now = Date.now();
    await openDriverSession(prisma, d.user.id, new Date(now - 2 * TIMEOUT));
    wentQuiet(d.user.id, now, TIMEOUT + MIN);

    expect(await takeSilentDriversOffline(prisma, new Date(now))).toEqual([d.user.id]);
    expect(await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } })).toMatchObject({
      isOnline: false,
      currentZoneId: null,
    });
    const [session] = await prisma.driverOnlineSession.findMany({ where: { driverUserId: d.user.id } });
    expect(session).toMatchObject({ endReason: "TIMEOUT", endedAt: new Date(now - TIMEOUT - MIN) });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      to: d.token,
      title: "You're offline",
      body: "We lost touch with your phone for a while. Go online again when you're ready.",
      data: { kind: "WENT_OFFLINE" },
    });
    // Once: nothing more next minute.
    expect(await takeSilentDriversOffline(prisma, new Date(now + MIN))).toEqual([]);
  });

  it("never mid-trip", async () => {
    const d = await onlineDriver();
    const { ride } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: d.user.id });
    rideIds.push(ride.id);
    const now = Date.now();
    wentQuiet(d.user.id, now, 5 * TIMEOUT);
    expect(await takeSilentDriversOffline(prisma, new Date(now))).toEqual([]);
    expect(await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } })).toMatchObject({ isOnline: true });
    expect(fake.sent).toHaveLength(0);
  });

  it("leaves a driver who already went offline alone", async () => {
    const d = await onlineDriver();
    await prisma.driver.update({ where: { userId: d.user.id }, data: { isOnline: false } });
    const now = Date.now();
    wentQuiet(d.user.id, now, TIMEOUT);
    expect(await takeSilentDriversOffline(prisma, new Date(now))).toEqual([]);
    expect(fake.sent).toHaveLength(0);
  });

  it("their app hears 'taken offline' until they go online again", async () => {
    const d = await onlineDriver();
    const now = Date.now();
    await openDriverSession(prisma, d.user.id, new Date(now - 2 * TIMEOUT));
    expect(await wasTakenOffline(prisma, d.user.id)).toBe(false);
    wentQuiet(d.user.id, now, TIMEOUT);
    await takeSilentDriversOffline(prisma, new Date(now));
    expect(await wasTakenOffline(prisma, d.user.id)).toBe(true);
    await prisma.driver.update({ where: { userId: d.user.id }, data: { isOnline: true } });
    await openDriverSession(prisma, d.user.id);
    expect(await wasTakenOffline(prisma, d.user.id)).toBe(false);
  });
});
