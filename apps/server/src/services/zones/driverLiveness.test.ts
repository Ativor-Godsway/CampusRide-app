/**
 * Stale drivers (2026-11-24): online counts only if the app was heard from in
 * the last 10 minutes. Pins:
 *   1. a stale driver gets no offer (dispatch), no listing as a fitting car,
 *      and doesn't count as "a driver online" for booking; a live one does;
 *   2. the sweep sets a stale (or never-heard) driver offline: no zone,
 *      autoOfflineAt, session ended TIMEOUT at the last contact, the push in
 *      the owner's words — once; a live driver, one mid-trip and a review
 *      demo driver are left alone;
 *   3. the app's next presence hears when, until the driver goes online;
 *   4. heartbeats are written at most once a minute per driver.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_STALE_AFTER_MS } from "@rida/shared";
import { prisma } from "../../db/prisma";
import { cleanupRide, createTestDriver, createTestRide, getTestZones } from "../ride/testFixtures";
import { getEligibleDrivers } from "../ride/dispatch";
import { countOnlineDrivers } from "../service/serviceHours";
import { openDriverSession } from "../stats/driverSessions";
import { resetPushStateForTests, setPushTransportForTests } from "../push/pushService";
import { fakeTransport, newToken } from "../push/testFixtures";
import {
  HEARTBEAT_WRITE_EVERY_MS,
  autoOfflineAt,
  noteDriverHeartbeat,
  resetDriverLivenessForTests,
  takeStaleDriversOffline,
} from "./driverLiveness";

const MIN = 60_000;
const userIds: string[] = [];
const rideIds: string[] = [];
let fake: ReturnType<typeof fakeTransport>;

beforeEach(() => {
  resetDriverLivenessForTests();
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

/** An online driver in the pickup zone, last heard `ago` ms before now (null: never). */
async function onlineDriver(ago: number | null, opts: { push?: boolean } = {}) {
  const { pickup } = await getTestZones();
  const { user } = await createTestDriver({
    isOnline: true,
    isApproved: true,
    currentZoneId: pickup.id,
    lastHeartbeatAt: ago === null ? null : new Date(Date.now() - ago),
  });
  userIds.push(user.id);
  const token = newToken();
  if (opts.push) await prisma.pushToken.create({ data: { userId: user.id, token, app: "driver", platform: "android" } });
  return { user, token };
}

const stale = DRIVER_STALE_AFTER_MS + MIN;

describe("a stale driver is not online for dispatch or booking", () => {
  it("gets no offer; a live driver in the same zone does", async () => {
    const { pickup } = await getTestZones();
    const live = await onlineDriver(2 * MIN);
    const silent = await onlineDriver(stale);
    const never = await onlineDriver(null);
    const offered = (await getEligibleDrivers(prisma, { pickupZoneId: pickup.id })).map((d) => d.userId);
    expect(offered).toContain(live.user.id);
    expect(offered).not.toContain(silent.user.id);
    expect(offered).not.toContain(never.user.id);
  });

  it("doesn't count as a driver online (the 'no drivers online' booking block)", async () => {
    const before = await countOnlineDrivers(prisma);
    await onlineDriver(stale);
    await onlineDriver(null);
    expect(await countOnlineDrivers(prisma)).toBe(before);
    await onlineDriver(MIN);
    expect(await countOnlineDrivers(prisma)).toBe(before + 1);
  });

  it("is live again as soon as their app is heard from", async () => {
    const { pickup } = await getTestZones();
    const d = await onlineDriver(stale);
    noteDriverHeartbeat(prisma, d.user.id);
    await new Promise((r) => setTimeout(r, 50));
    expect((await getEligibleDrivers(prisma, { pickupZoneId: pickup.id })).map((x) => x.userId)).toContain(d.user.id);
  });
});

describe("setting stale drivers offline", () => {
  it("offline, no zone, autoOfflineAt, session ended TIMEOUT at the last contact, and the push — once", async () => {
    const now = Date.now();
    const d = await onlineDriver(stale, { push: true });
    await openDriverSession(prisma, d.user.id, new Date(now - 2 * stale));

    expect(await takeStaleDriversOffline(prisma, new Date(now))).toContain(d.user.id);
    const row = await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } });
    expect(row).toMatchObject({ isOnline: false, currentZoneId: null });
    expect(row.autoOfflineAt?.getTime()).toBe(now);
    const [session] = await prisma.driverOnlineSession.findMany({ where: { driverUserId: d.user.id } });
    expect(session!.endReason).toBe("TIMEOUT");
    expect(session!.endedAt!.getTime()).toBe(row.lastHeartbeatAt!.getTime());
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      to: d.token,
      title: "You're offline",
      body: "You were set offline because your app lost connection. Go online again to get requests.",
      data: { kind: "WENT_OFFLINE" },
    });
    expect(await takeStaleDriversOffline(prisma, new Date(now + MIN))).not.toContain(d.user.id);
    expect(fake.sent).toHaveLength(1);
  });

  it("a driver never heard from (left online from before) goes too, their session ending at its last sighting", async () => {
    const now = Date.now();
    const d = await onlineDriver(null);
    const started = new Date(now - 30 * 60 * MIN);
    await prisma.driverOnlineSession.create({ data: { driverUserId: d.user.id, startedAt: started, lastSeenAt: new Date(started.getTime() + 5 * MIN) } });
    expect(await takeStaleDriversOffline(prisma, new Date(now))).toContain(d.user.id);
    const [session] = await prisma.driverOnlineSession.findMany({ where: { driverUserId: d.user.id } });
    expect(session!.endedAt!.getTime()).toBe(started.getTime() + 5 * MIN);
  });

  it("leaves a live driver, one mid-trip and a review demo driver alone", async () => {
    const now = Date.now();
    const live = await onlineDriver(DRIVER_STALE_AFTER_MS - MIN);
    const onTrip = await onlineDriver(stale);
    const { ride } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: onTrip.user.id });
    rideIds.push(ride.id);
    const demo = await onlineDriver(stale);
    await prisma.user.update({ where: { id: demo.user.id }, data: { isReviewDemo: true } });

    const taken = await takeStaleDriversOffline(prisma, new Date(now));
    for (const d of [live, onTrip, demo]) {
      expect(taken).not.toContain(d.user.id);
      expect(await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } })).toMatchObject({ isOnline: true });
    }
  });

  it("their app hears when it happened, until they go online again", async () => {
    const d = await onlineDriver(stale);
    expect(await autoOfflineAt(prisma, d.user.id)).toBeNull();
    const at = new Date();
    await takeStaleDriversOffline(prisma, at);
    expect((await autoOfflineAt(prisma, d.user.id))?.getTime()).toBe(at.getTime());
    // Going online (PATCH /driver/availability) clears it.
    await prisma.driver.update({ where: { userId: d.user.id }, data: { isOnline: true, autoOfflineAt: null, lastHeartbeatAt: new Date() } });
    expect(await autoOfflineAt(prisma, d.user.id)).toBeNull();
  });
});

describe("heartbeats", () => {
  it("are written at most once a minute per driver", async () => {
    const d = await onlineDriver(stale);
    const t0 = Date.now();
    noteDriverHeartbeat(prisma, d.user.id, t0);
    noteDriverHeartbeat(prisma, d.user.id, t0 + 10_000);
    await new Promise((r) => setTimeout(r, 50));
    const first = (await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } })).lastHeartbeatAt!.getTime();
    expect(first).toBe(t0);
    noteDriverHeartbeat(prisma, d.user.id, t0 + HEARTBEAT_WRITE_EVERY_MS);
    await new Promise((r) => setTimeout(r, 50));
    expect((await prisma.driver.findUniqueOrThrow({ where: { userId: d.user.id } })).lastHeartbeatAt!.getTime()).toBe(t0 + HEARTBEAT_WRITE_EVERY_MS);
  });
});
