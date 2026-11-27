/**
 * The pickup wait fee (2026-11-25, services/ride/waitFee.ts):
 * - "Arrived" starts the rider's 2:30 free wait only when the driver's GPS is
 *   within ~100 m of that rider's pickup ("Get closer…" otherwise);
 * - picked up after the free wait: a flat GH 2 on THAT rider's seat, once
 *   (7 -> 9, far 9 -> 11, Ride alone 15 -> 17); others in the car unaffected;
 * - the 85/15 split covers the whole fare, fee included;
 * - no fee unless the rider was warned (push accepted, or their app has it);
 * - "Rider didn't show" only after 5 minutes of waiting, no fee, recorded;
 * - the three numbers are admin settings.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { CLIENT_FEATURES_HEADER, DEFAULT_WAIT_FEE_SETTINGS, splitFare } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { registerAdminDispatchRoutes } from "./adminDispatch";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestRide, createTestUser, getTestZones } from "../services/ride/testFixtures";
import {
  installWaitFeeAppMarker,
  readWaitFeeSettings,
  resetWaitFeeAppMarksForTests,
  setWaitFeeSettingsForTests,
  waitFeesByDay,
  warnRiderOfWait,
} from "../services/ride/waitFee";
import { accraDay, daysIn } from "../services/admin/period";

const push = vi.hoisted(() => ({ accepted: 0, sent: [] as Array<{ kind: string; body?: unknown; dedupeKey?: string }> }));
vi.mock("../services/push/pushService", () => ({
  isPushEnabled: () => true,
  sendPush: vi.fn(async (_prisma: unknown, input: { kind: string; text?: unknown; dedupeKey?: string }) => {
    push.sent.push({ kind: input.kind, body: input.text, dedupeKey: input.dedupeKey });
    return push.accepted;
  }),
}));
vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

const NEW_APP = { [CLIENT_FEATURES_HEADER]: "wait-fee" };
const SEC = 1000;

let app: FastifyInstance;
const rideIds: string[] = [];
const driverIds: string[] = [];
const userIds: string[] = [];
let pickupCentre: { latitude: number; longitude: number };

beforeAll(async () => {
  app = Fastify();
  installWaitFeeAppMarker(app, prisma);
  registerDriverRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  registerAdminDispatchRoutes(app, prisma);
  await app.ready();
  const { pickup } = await getTestZones();
  pickupCentre = { latitude: pickup.latitude, longitude: pickup.longitude };
});

beforeEach(() => {
  push.accepted = 0;
  push.sent.length = 0;
  setWaitFeeSettingsForTests();
  resetWaitFeeAppMarksForTests();
});

afterEach(async () => {
  const rides = await prisma.ride.findMany({ where: { id: { in: rideIds } }, include: { passengers: true } });
  const riders = new Set(rides.flatMap((r) => [r.riderId, ...r.passengers.map((p) => p.riderId)]));
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [...riders, ...userIds] } } });
  rideIds.length = 0;
  userIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
  await prisma.waitFeeSetting.deleteMany({});
});

afterAll(async () => {
  await app.close();
});

/** ~330 m north of the pickup zone's centre. */
const far = () => ({ latitude: pickupCentre.latitude + 0.003, longitude: pickupCentre.longitude });
/** ~30 m from it. */
const near = () => ({ latitude: pickupCentre.latitude + 0.00027, longitude: pickupCentre.longitude });

async function car(fares: number[], opts: { type?: "SHARED" | "LONE"; riderAppHasIt?: boolean } = {}) {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(user.id);
  const riders: Array<{ id: string }> = [];
  for (let i = 0; i < fares.length; i++) {
    const r = await createTestUser("RIDER");
    if (opts.riderAppHasIt) await prisma.user.update({ where: { id: r.id }, data: { waitFeeAppAt: new Date() } });
    riders.push(r);
  }
  const { ride } = await createTestRide({
    type: opts.type ?? "SHARED",
    status: "MATCHED",
    driverId: user.id,
    occupancy: fares.length,
    passengers: fares.map((lockedFare, i) => ({ riderId: riders[i]!.id, status: "WAITING", lockedFare })),
  });
  rideIds.push(ride.id);
  const seats = [...ride.passengers].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const token = signAccessToken({ userId: user.id, role: "DRIVER" });
  const act = (seatId: string, action: string, opts2: { at?: { latitude: number; longitude: number } | null; newApp?: boolean; body?: object } = {}) =>
    app.inject({
      method: "POST",
      url: `/rides/${ride.id}/passengers/${seatId}/${action}`,
      headers: { authorization: `Bearer ${token}`, ...(opts2.newApp === false ? {} : NEW_APP) },
      payload: opts2.body ?? (opts2.at ? { lat: opts2.at.latitude, lng: opts2.at.longitude } : {}),
    });
  return { ride, seats, riders, act, driver: user };
}

const seatOf = (id: string) => prisma.ridePassenger.findUniqueOrThrow({ where: { id } });

/** Winds a running free wait back by `ms` (instead of waiting). */
async function windBack(seatId: string, ms: number) {
  const s = await seatOf(seatId);
  const back = (d: Date | null) => (d ? new Date(d.getTime() - ms) : null);
  await prisma.ridePassenger.update({
    where: { id: seatId },
    data: {
      arrivedAt: back(s.arrivedAt),
      waitStartedAt: back(s.waitStartedAt),
      freeWaitEndsAt: back(s.freeWaitEndsAt),
      noShowOpensAt: back(s.noShowOpensAt),
      riderWarnedAt: back(s.riderWarnedAt),
    },
  });
}

describe("the GPS check on Arrived", () => {
  it("starts the timer within ~100 m of the pickup", async () => {
    const { seats, act } = await car([700], { riderAppHasIt: true });
    const res = await act(seats[0]!.id, "arrived", { at: near() });
    expect(res.statusCode).toBe(200);
    expect(res.json().waitTimer).toBe("STARTED");
    const s = await seatOf(seats[0]!.id);
    expect(s.status).toBe("ARRIVED");
    expect(s.waitStartedAt).toBeInstanceOf(Date);
    expect(s.freeWaitEndsAt!.getTime() - s.waitStartedAt!.getTime()).toBe(150 * SEC);
    expect(s.noShowOpensAt!.getTime() - s.waitStartedAt!.getTime()).toBe(5 * 60 * SEC);
    expect(s.waitFeeAmount).toBe(200);
  });

  it("further away: the arrival stands, no timer, and the driver is told to get closer; a tap from nearer starts it", async () => {
    const { seats, act } = await car([700], { riderAppHasIt: true });
    const res = await act(seats[0]!.id, "arrived", { at: far() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ waitTimer: "TOO_FAR", waitTimerMessage: "Get closer to the pickup to start the wait timer." });
    let s = await seatOf(seats[0]!.id);
    expect(s.status).toBe("ARRIVED");
    expect(s.waitStartedAt).toBeNull();
    expect(s.noShowOpensAt).toBeNull();

    const again = await act(seats[0]!.id, "arrived", { at: near() });
    expect(again.json().waitTimer).toBe("STARTED");
    s = await seatOf(seats[0]!.id);
    expect(s.waitStartedAt).toBeInstanceOf(Date);
    // A repeat once it runs changes nothing.
    const third = await act(seats[0]!.id, "arrived", { at: near() });
    expect(third.json().waitTimer).toBeUndefined();
    expect((await seatOf(seats[0]!.id)).waitStartedAt!.getTime()).toBe(s.waitStartedAt!.getTime());
  });

  it("no position from the phone (and none from the trip): no timer", async () => {
    const { seats, act } = await car([700]);
    const res = await act(seats[0]!.id, "arrived");
    expect(res.json().waitTimer).toBe("NO_POSITION");
    expect((await seatOf(seats[0]!.id)).waitStartedAt).toBeNull();
  });

  it("an older driver app (no feature header): no timer and no fee, no-show 5 min after arriving", async () => {
    const { seats, act } = await car([700], { riderAppHasIt: true });
    const res = await act(seats[0]!.id, "arrived", { at: near(), newApp: false });
    expect(res.json().waitTimer).toBeUndefined();
    const s = await seatOf(seats[0]!.id);
    expect(s.waitStartedAt).toBeNull();
    expect(s.noShowOpensAt!.getTime() - s.arrivedAt!.getTime()).toBe(5 * 60 * SEC);
    await windBack(seats[0]!.id, 10 * 60 * SEC);
    await act(seats[0]!.id, "pickup", { newApp: false });
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(700);
  });
});

describe("the wait fee", () => {
  it("is not charged when the rider is picked up before 2:30", async () => {
    const { seats, act } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 149 * SEC);
    await act(seats[0]!.id, "pickup");
    const s = await seatOf(seats[0]!.id);
    expect(s.waitFee).toBeNull();
    expect(s.lockedFare).toBe(700);
  });

  it("at 2:30 goes on the late rider's seat only: Shared 7 -> 9, the other rider stays 7", async () => {
    const { seats, act } = await car([700, 700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await act(seats[1]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 150 * SEC);
    await act(seats[0]!.id, "pickup");
    await act(seats[1]!.id, "pickup");
    const [late, onTime] = [await seatOf(seats[0]!.id), await seatOf(seats[1]!.id)];
    expect(late.waitFee).toBe(200);
    expect(late.lockedFare).toBe(900);
    expect(onTime.waitFee).toBeNull();
    expect(onTime.lockedFare).toBe(700);
    // Once, not per minute: a later drop-off charges what was locked at pickup.
    await act(seats[0]!.id, "dropoff");
    expect((await seatOf(seats[0]!.id)).fareCharged).toBe(900);
  });

  it("per booking, not per seat: a 2-seat booking 14 + 2 = 16 (once)", async () => {
    const { seats, act } = await car([1400], { riderAppHasIt: true });
    await prisma.ridePassenger.update({ where: { id: seats[0]!.id }, data: { seats: 2 } });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 4 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    const s = await seatOf(seats[0]!.id);
    expect(s.waitFee).toBe(200);
    expect(s.lockedFare).toBe(1600);
  });

  it("far Shared 9 + 2 = 11", async () => {
    const { seats, act } = await car([900], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 10 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(1100);
  });

  it("Ride alone 15 + 2 = 17, and the 85/15 split covers the fee", async () => {
    const { ride, seats, act } = await car([1500], { type: "LONE", riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 3 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(1700);
    await act(seats[0]!.id, "dropoff");
    expect((await seatOf(seats[0]!.id)).fareCharged).toBe(1700);
    expect(splitFare(1700)).toEqual({ commission: 255, driverShare: 1445 });
    await vi.waitFor(async () => {
      const ledger = await prisma.commissionLedger.findFirst({ where: { rideId: ride.id } });
      expect(ledger?.amountPesewas).toBe(255);
    });
  });

  it("the Shared car's commission is 15% of every fare including the late rider's fee", async () => {
    const { ride, seats, act } = await car([700, 700], { riderAppHasIt: true });
    for (const s of seats) await act(s.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 160 * SEC);
    for (const s of seats) await act(s.id, "pickup");
    for (const s of seats) await act(s.id, "dropoff");
    await vi.waitFor(async () => {
      const ledger = await prisma.commissionLedger.findFirst({ where: { rideId: ride.id } });
      expect(ledger?.amountPesewas).toBe(splitFare(900 + 700).commission);
    });
    expect(splitFare(1600)).toEqual({ commission: 240, driverShare: 1360 });
  });

  it("is not charged when the rider wasn't warned (no push accepted, app without the timer)", async () => {
    const { seats, act } = await car([700]);
    await act(seats[0]!.id, "arrived", { at: near() });
    await vi.waitFor(() => expect(push.sent.some((p) => p.kind === "DRIVER_ARRIVED")).toBe(true));
    await windBack(seats[0]!.id, 10 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    const s = await seatOf(seats[0]!.id);
    expect(s.riderWarnedAt).toBeNull();
    expect(s.waitFee).toBeNull();
    expect(s.lockedFare).toBe(700);
  });

  it("is charged when the arrival push (stating the free wait and fee) was accepted", async () => {
    push.accepted = 1;
    const { seats, act } = await car([700]);
    await act(seats[0]!.id, "arrived", { at: near() });
    await vi.waitFor(async () => expect((await seatOf(seats[0]!.id)).riderWarnedAt).toBeInstanceOf(Date));
    const sent = push.sent.find((p) => p.kind === "DRIVER_ARRIVED");
    expect(sent?.body).toEqual({ freeWait: { seconds: 150, feePesewas: 200 } });
    await windBack(seats[0]!.id, 151 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(900);
  });

  it("a warning that came after the free wait ended doesn't count", async () => {
    const { seats, act } = await car([700]);
    await act(seats[0]!.id, "arrived", { at: near() });
    const s = await seatOf(seats[0]!.id);
    await warnRiderOfWait(prisma, { ...s, waitStartedAt: s.waitStartedAt!, freeWaitEndsAt: s.freeWaitEndsAt!, waitFeeAmount: 200 });
    await windBack(seats[0]!.id, 10 * 60 * SEC);
    push.accepted = 1;
    const back = await seatOf(seats[0]!.id);
    await warnRiderOfWait(prisma, { ...back, waitStartedAt: back.waitStartedAt!, freeWaitEndsAt: back.freeWaitEndsAt!, waitFeeAmount: 200 });
    expect((await seatOf(seats[0]!.id)).riderWarnedAt).toBeNull();
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).waitFee).toBeNull();
  });

  it("an undone pickup takes the fee off again", async () => {
    const { seats, act } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 200 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(900);
    const undo = await act(seats[0]!.id, "undo", { body: { step: "pickup" } });
    expect(undo.statusCode).toBe(200);
    const s = await seatOf(seats[0]!.id);
    expect(s.status).toBe("ARRIVED");
    expect(s.lockedFare).toBe(700);
    expect(s.waitFee).toBeNull();
  });
});

describe("rider didn't show", () => {
  it("opens only after 5 minutes of waiting; no fee, recorded", async () => {
    const { ride, seats, act } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 4 * 60 * SEC + 50 * SEC);
    const early = await act(seats[0]!.id, "cancel", { body: { reason: "NO_SHOW" } });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "NO_SHOW_TOO_EARLY" });
    await windBack(seats[0]!.id, 11 * SEC);
    const late = await act(seats[0]!.id, "cancel", { body: { reason: "NO_SHOW" } });
    expect(late.statusCode).toBe(200);
    const s = await seatOf(seats[0]!.id);
    expect(s.status).toBe("CANCELLED");
    expect(s.noShowAt).toBeInstanceOf(Date);
    expect(s.waitFee).toBeNull();
    expect(await prisma.commissionLedger.count({ where: { rideId: ride.id } })).toBe(0);
  });

  it("without a wait timer (driver wasn't near) it stays closed, saying to get closer", async () => {
    const { seats, act } = await car([700]);
    await act(seats[0]!.id, "arrived", { at: far() });
    await prisma.ridePassenger.update({ where: { id: seats[0]!.id }, data: { arrivedAt: new Date(Date.now() - 20 * 60 * SEC) } });
    const res = await act(seats[0]!.id, "cancel", { body: { reason: "NO_SHOW" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("Get closer to the pickup to start the wait timer.");
  });
});

describe("what the apps see", () => {
  it("the driver's trip has each seat's countdown, fee to come, and no-show time", async () => {
    const { seats, act, driver } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    const res = await app.inject({
      method: "GET",
      url: "/driver/rides/active",
      headers: { authorization: `Bearer ${signAccessToken({ userId: driver.id, role: "DRIVER" })}` },
    });
    const p = res.json().ride.passengers[0];
    expect(p.wait).toMatchObject({ timerStarted: true, feePesewas: 200 });
    expect(Date.parse(p.wait.freeUntil) - Date.parse(p.wait.startedAt)).toBe(150 * SEC);
    expect(typeof p.noShowOpensAt).toBe("string");
    expect(p.waitFeePesewas).toBeNull();
  });

  it("the rider sees their own wait, never a fellow rider's; the app's header marks them as warned", async () => {
    const { ride, seats, riders, act } = await car([700, 700]);
    // The ride's owner is a separate user here; ask as the seat's rider.
    const riderToken = signAccessToken({ userId: riders[0]!.id, role: "RIDER" });
    await app.inject({ method: "GET", url: `/rides/${ride.id}`, headers: { authorization: `Bearer ${riderToken}`, ...NEW_APP } });
    await vi.waitFor(async () =>
      expect((await prisma.user.findUniqueOrThrow({ where: { id: riders[0]!.id } })).waitFeeAppAt).toBeInstanceOf(Date),
    );
    await act(seats[0]!.id, "arrived", { at: near() });
    await act(seats[1]!.id, "arrived", { at: near() });
    const res = await app.inject({ method: "GET", url: `/rides/${ride.id}`, headers: { authorization: `Bearer ${riderToken}` } });
    const mine = res.json().ride.passengers.find((p: { id: string }) => p.id === seats[0]!.id);
    const theirs = res.json().ride.passengers.find((p: { id: string }) => p.id === seats[1]!.id);
    expect(mine.wait).toMatchObject({ timerStarted: true, feePesewas: 200 });
    expect(theirs.wait).toBeUndefined();
    expect(theirs).not.toHaveProperty("waitStartedAt");
    expect(theirs).not.toHaveProperty("riderWarnedAt");
  });
});

describe("admin settings", () => {
  async function admin() {
    const created = await createTestUser("RIDER");
    userIds.push(created.id);
    await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } });
    return { id: created.id, headers: { authorization: `Bearer ${signAccessToken({ userId: created.id, role: "ADMIN" })}` } };
  }

  it("are editable (free wait, fee, no-show) and apply to the next wait", async () => {
    const a = await admin();
    const get = await app.inject({ method: "GET", url: "/admin/wait-fee-settings", headers: a.headers });
    expect(get.json().settings).toMatchObject(DEFAULT_WAIT_FEE_SETTINGS);
    const put = (payload: object) => app.inject({ method: "PUT", url: "/admin/wait-fee-settings", headers: a.headers, payload });
    expect((await put({ freeWaitSeconds: 10, feePesewas: 200, noShowMinutes: 5 })).statusCode).toBe(400);
    expect((await put({ freeWaitSeconds: 600, feePesewas: 200, noShowMinutes: 5 })).statusCode).toBe(400); // no-show before the free wait ends
    const ok = await put({ freeWaitSeconds: 120, feePesewas: 300, noShowMinutes: 6 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ freeWaitSeconds: 120, feePesewas: 300, noShowMinutes: 6 });
    expect(await readWaitFeeSettings(prisma)).toMatchObject({ freeWaitSeconds: 120, feePesewas: 300, noShowMinutes: 6 });
    expect(await prisma.adminAuditLog.count({ where: { action: "ride.wait_fee", actor: a.id } })).toBe(1);
    await prisma.adminAuditLog.deleteMany({ where: { actor: a.id } });

    const { seats, act } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    const s = await seatOf(seats[0]!.id);
    expect(s.freeWaitEndsAt!.getTime() - s.waitStartedAt!.getTime()).toBe(120 * SEC);
    expect(s.noShowOpensAt!.getTime() - s.waitStartedAt!.getTime()).toBe(6 * 60 * SEC);
    expect(s.waitFeeAmount).toBe(300);
    await windBack(seats[0]!.id, 121 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(1000);
  });

  it("a fee of 0 turns the wait fee off", async () => {
    setWaitFeeSettingsForTests({ feePesewas: 0 });
    const { seats, act } = await car([700], { riderAppHasIt: true });
    await act(seats[0]!.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 10 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    expect((await seatOf(seats[0]!.id)).lockedFare).toBe(700);
  });

  it("wait fees collected and no-shows per day", async () => {
    const { seats, act } = await car([700, 700, 700], { riderAppHasIt: true });
    for (const s of seats) await act(s.id, "arrived", { at: near() });
    await windBack(seats[0]!.id, 6 * 60 * SEC);
    await windBack(seats[2]!.id, 6 * 60 * SEC);
    await act(seats[0]!.id, "pickup");
    await act(seats[1]!.id, "pickup");
    await act(seats[2]!.id, "cancel", { body: { reason: "NO_SHOW" } });
    await act(seats[0]!.id, "dropoff");
    await act(seats[1]!.id, "dropoff");
    const now = new Date();
    const period = { from: new Date(now.getTime() - 60 * 60 * SEC), to: new Date(now.getTime() + 60 * 60 * SEC) };
    const res = await waitFeesByDay(prisma, period, accraDay, daysIn(period));
    expect(res.totalPesewas).toBeGreaterThanOrEqual(200);
    const today = res.days.find((d) => d.day === accraDay(now))!;
    expect(today.feesPesewas).toBeGreaterThanOrEqual(200);
    expect(today.noShows).toBeGreaterThanOrEqual(1);
  });
});
