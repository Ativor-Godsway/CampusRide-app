/**
 * Admin redesign money routes: the commission rate and waiver (and what a
 * waiver does to drivers: nothing owed, nothing shown, nobody blocked, no
 * payment taken), top-ups paid to drivers (Payouts), the drivers list's new
 * money columns, the KPIs endpoint and "last changed by" for Settings.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { prisma } from "../db/prisma";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken } from "../services/auth/tokens";
import { getTestZones } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { clearAdminCache } from "../services/admin/cache";
import { driverBalance, reconciles, walkBalance } from "../services/admin/cash";
import { commissionBlock } from "../services/commission/enforcement";
import { clearCommissionTermsCache, commissionFor, commissionTermsProblem, isWaivedAt } from "../services/commission/settings";
import { finalizeRideCompletion } from "../services/ride/completion";
import type { PaystackClient } from "../services/commission/paystack";

/** A Paystack that is "configured" but must never be reached while waived. */
const paystack: PaystackClient = {
  configured: true,
  chargeMomo: async () => {
    throw new Error("Paystack must not be called while commission is waived");
  },
  submitOtp: async () => ({ kind: "refused", message: "no" }),
  initializeCheckout: async () => ({ kind: "failed", message: "no" }) as never,
  verify: async () => ({ kind: "not_found" }),
};

let app: FastifyInstance;
const userIds: string[] = [];
const rideIds: string[] = [];
let admin: User;
let zones: { pickup: { id: string }; dropoff: { id: string } };

const auth = (u: User) => ({ authorization: `Bearer ${signAccessToken({ userId: u.id, role: u.role })}` });
const get = (url: string, as: User) => app.inject({ method: "GET", url, headers: auth(as) });
const post = (url: string, payload: object, as: User) => app.inject({ method: "POST", url, headers: auth(as), payload });
const put = (url: string, payload: object, as: User) => app.inject({ method: "PUT", url, headers: auth(as), payload });

async function user(role: "RIDER" | "DRIVER" | "ADMIN", name: string) {
  const u = await prisma.user.create({ data: { phone: uniqueGhanaPhone(), name, role } });
  userIds.push(u.id);
  return u;
}

async function driver(name: string) {
  const u = await user("DRIVER", name);
  await prisma.driver.create({ data: { userId: u.id, carMake: "Toyota", carModel: "Vitz", carColor: "Green", plate: `GT ${Math.floor(Math.random() * 9000) + 1000}-30`, isApproved: true } });
  return u;
}

/** A finished cash Ride alone of `fare` pesewas, completed through the real completion path. */
async function completeTrip(d: User, fare: number, completedAt = new Date()) {
  const rider = await user("RIDER", "Ama Rider");
  const ride = await prisma.ride.create({
    data: {
      riderId: rider.id,
      driverId: d.id,
      pickupZoneId: zones.pickup.id,
      dropoffZoneId: zones.dropoff.id,
      type: "LONE",
      status: "COMPLETED",
      completedAt,
      passengers: { create: [{ riderId: rider.id, pickupZoneId: zones.pickup.id, dropoffZoneId: zones.dropoff.id, status: "DROPPED_OFF", lockedFare: fare, fareCharged: fare }] },
    } as never,
  });
  rideIds.push(ride.id);
  await finalizeRideCompletion(prisma, { id: ride.id, type: "LONE", occupancy: 1, paymentMethod: "CASH", source: "APP", isReviewDemo: false }, d.id);
  return ride;
}

/** A ledger row written as if completed at `at` (for back-dated waivers). */
async function pastCommission(d: User, amount: number, at: Date) {
  const rider = await user("RIDER", "Kofi Rider");
  const ride = await prisma.ride.create({
    data: { riderId: rider.id, driverId: d.id, pickupZoneId: zones.pickup.id, dropoffZoneId: zones.dropoff.id, type: "LONE", status: "COMPLETED", completedAt: at } as never,
  });
  rideIds.push(ride.id);
  await prisma.commissionLedger.create({ data: { driverUserId: d.id, rideId: ride.id, amountPesewas: amount, createdAt: at } });
  return ride;
}

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const setTerms = (body: object) => put("/admin/commission-terms", body, admin);

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: new DummyOtpService(), paymentService: new DummyPaymentService(), paystack });
  await app.ready();
  zones = await getTestZones();
  admin = await user("ADMIN", "Money Admin");
});

beforeEach(async () => {
  clearAdminCache();
  clearCommissionTermsCache();
  await prisma.commissionSetting.deleteMany({});
});

afterAll(async () => {
  await prisma.commissionSetting.deleteMany({});
  clearCommissionTermsCache();
  await prisma.driverTopUp.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds }, reversesId: { not: null } } });
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.driverPaystackPayment.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actor: { in: userIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe("commission rules (pure)", () => {
  it("works commission out at the rate, to the pesewa", () => {
    expect(commissionFor(700, 1500)).toBe(105);
    expect(commissionFor(1500, 1500)).toBe(225);
    expect(commissionFor(700, 2000)).toBe(140);
    expect(commissionFor(700, 0)).toBe(0);
  });

  it("waives from the start day, and only while switched on", () => {
    const from = new Date("2026-11-23T00:00:00Z");
    expect(isWaivedAt({ waived: true, waivedFrom: from }, new Date("2026-11-23T08:00:00Z"))).toBe(true);
    expect(isWaivedAt({ waived: true, waivedFrom: from }, new Date("2026-11-22T23:59:00Z"))).toBe(false);
    expect(isWaivedAt({ waived: false, waivedFrom: from }, new Date("2026-11-24T08:00:00Z"))).toBe(false);
  });

  it("refuses a future start, a missing start and a rate over 50%", () => {
    const now = new Date("2026-11-29T10:00:00Z");
    expect(commissionTermsProblem({ rateBps: 1500, waived: true, waivedFromDay: "2026-11-30" }, now)).toMatch(/future/);
    expect(commissionTermsProblem({ rateBps: 1500, waived: true, waivedFromDay: null }, now)).toMatch(/Choose the day/);
    expect(commissionTermsProblem({ rateBps: 5001, waived: false, waivedFromDay: null }, now)).toMatch(/0% to 50%/);
    expect(commissionTermsProblem({ rateBps: 1500, waived: true, waivedFromDay: "2026-11-23" }, now)).toBeNull();
  });
});

describe("commission terms", () => {
  it("defaults to 15%, not waived", async () => {
    const res = await get("/admin/commission-terms", admin);
    expect(res.statusCode).toBe(200);
    expect(res.json().terms).toMatchObject({ rateBps: 1500, waived: false, waivedFromDay: null, updatedBy: null });
  });

  it("charges each completed trip automatically at the rate in force", async () => {
    const d = await driver("Rate Driver");
    expect((await setTerms({ rateBps: 2000, waived: false })).statusCode).toBe(200);
    const ride = await completeTrip(d, 1000);
    const row = await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: ride.id } });
    expect(row).toMatchObject({ amountPesewas: 200, rateBps: 2000, waived: false });
    expect((await driverBalance(prisma, d.id)).balancePesewas).toBe(200);
  });

  it("while waived: trips owe nothing, the driver app shows nothing owed, no payment, nobody blocked", async () => {
    const d = await driver("Waived Driver");
    // Owed before the waiver's start: still on file, but not shown while waived.
    await pastCommission(d, 300, new Date(Date.now() - 10 * 86_400_000));
    expect((await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(-3) })).statusCode).toBe(200);
    const ride = await completeTrip(d, 700);
    const row = await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: ride.id } });
    expect(row).toMatchObject({ amountPesewas: 105, waived: true, rateBps: 1500 });

    const balance = (await get("/driver/balance", d)).json();
    expect(balance).toMatchObject({ balancePesewas: 0, commissionPesewas: 0, commissionWaived: true, blocked: false, warning: null, quote: null, pendingPayment: null });
    expect(balance.history).toEqual([]);

    const pay = await post("/driver/balance/payments", { channel: "MOMO", phone: "024 123 4567", network: "MTN" }, d);
    expect(pay.statusCode).toBe(409);
    expect(pay.json().code).toBe("COMMISSION_WAIVED");

    // Enforcement on, limit far below what they owe from before: still not blocked.
    await put("/admin/commission-settings", { debtLimitPesewas: 100, warningPercent: 80, enforcementEnabled: true, feeBps: 0, feeCapPesewas: null }, admin);
    expect(await commissionBlock(prisma, d.id)).toBeNull();

    // The trip's earnings: the whole fare is the driver's.
    const history = (await get("/driver/rides/history", d)).json();
    const item = history.rides.find((r: { rideId: string }) => r.rideId === ride.id);
    expect(item).toMatchObject({ facePesewas: 700, driverGrossPesewas: 700 });
  });

  it("a back-dated waiver marks trips completed since its start; switching it off charges new trips", async () => {
    const d = await driver("Backdated Driver");
    const before = await pastCommission(d, 105, new Date(Date.now() - 5 * 86_400_000));
    const during = await pastCommission(d, 225, new Date(Date.now() - 2 * 86_400_000));
    expect((await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(-3) })).statusCode).toBe(200);
    expect((await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: before.id } })).waived).toBe(false);
    expect((await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: during.id } })).waived).toBe(true);
    // The admin's balance counts only what is charged.
    expect((await driverBalance(prisma, d.id)).owedPesewas).toBe(105);

    const off = await setTerms({ rateBps: 1500, waived: false });
    expect(off.statusCode).toBe(200);
    expect(off.json().terms).toMatchObject({ waived: false });
    const after = await completeTrip(d, 700);
    expect((await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: after.id } })).waived).toBe(false);
    // The waived trip stays waived after switching off.
    expect((await prisma.commissionLedger.findUniqueOrThrow({ where: { rideId: during.id } })).waived).toBe(true);
    const balance = (await get("/driver/balance", d)).json();
    expect(balance).toMatchObject({ balancePesewas: 105 + 105, commissionWaived: false });
  });

  it("refuses a future start day", async () => {
    const res = await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(2) });
    expect(res.statusCode).toBe(400);
  });

  it("is audit-logged and shows in Settings' last change", async () => {
    await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(0) });
    const log = await prisma.adminAuditLog.findFirst({ where: { actor: admin.id, action: "commission.terms" }, orderBy: { timestamp: "desc" } });
    expect(log?.reason).toMatch(/waived off → rate 15%, waived on from/);
    const changes = (await get("/admin/settings/changes", admin)).json();
    expect(changes.sections.commission).toMatchObject({ by: "Money Admin", action: "commission.terms" });
  });
});

describe("payouts (top-ups)", () => {
  it("records top-ups, adds them to fares per driver and per day, and removes one with a reason", async () => {
    const d = await driver("Topup Driver");
    await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(-1) });
    await completeTrip(d, 700);
    await completeTrip(d, 1500);
    const today = day(0);
    const driverRow = await prisma.driver.findUniqueOrThrow({ where: { userId: d.id } });

    const a = await post("/admin/payouts", { driverId: driverRow.id, amountPesewas: 5000, paidOn: today, method: "MOMO", note: "Guarantee" }, admin);
    expect(a.statusCode).toBe(201);
    const b = await post("/admin/payouts", { driverId: d.id, amountPesewas: 2000, paidOn: today, method: "CASH" }, admin);
    expect(b.statusCode).toBe(201);
    expect((await post("/admin/payouts", { driverId: d.id, amountPesewas: 2000, paidOn: day(3), method: "CASH" }, admin)).statusCode).toBe(400);

    const from = new Date(`${today}T00:00:00.000Z`).toISOString();
    const to = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    let report = (await get(`/admin/payouts?${q}`, admin)).json();
    let row = report.perDriver.find((r: { userId: string }) => r.userId === d.id);
    // Waived: fares 22 + top-ups 70 = 92, nothing taken off.
    expect(row).toMatchObject({ trips: 2, riders: 2, faresPesewas: 2200, commissionDuePesewas: 0, topUpsPesewas: 7000, incomePesewas: 9200 });
    expect(report.perDay.find((x: { day: string }) => x.day === today).topUpsPesewas).toBeGreaterThanOrEqual(7000);
    expect(report.topUps.find((t: { id: string }) => t.id === a.json().topUp.id)).toMatchObject({ method: "MOMO", note: "Guarantee", recordedBy: "Money Admin", removed: null });

    expect((await post(`/admin/payouts/${a.json().topUp.id}/remove`, { reason: "" }, admin)).statusCode).toBe(400);
    expect((await post(`/admin/payouts/${a.json().topUp.id}/remove`, { reason: "Entered twice" }, admin)).statusCode).toBe(200);
    expect((await post(`/admin/payouts/${a.json().topUp.id}/remove`, { reason: "Again" }, admin)).statusCode).toBe(409);
    report = (await get(`/admin/payouts?${q}`, admin)).json();
    row = report.perDriver.find((r: { userId: string }) => r.userId === d.id);
    expect(row.topUpsPesewas).toBe(2000);
    expect(report.topUps.find((t: { id: string }) => t.id === a.json().topUp.id).removed).toMatchObject({ by: "Money Admin", reason: "Entered twice" });

    const actions = (await prisma.adminAuditLog.findMany({ where: { actor: admin.id, action: { startsWith: "payout." } } })).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["payout.topup.record", "payout.topup.remove"]));

    // The drivers list carries the same money for the period.
    const list = (await get(`/admin/drivers?${q}`, admin)).json();
    const listed = list.drivers.find((r: { userId: string }) => r.userId === d.id);
    expect(listed).toMatchObject({ trips: 2, riders: 2, faresPesewas: 2200, commissionDuePesewas: 0, topUpsPesewas: 2000, balancePesewas: 0 });

    // The driver panel: earnings by day.
    const detail = (await get(`/admin/drivers/${d.id}?${q}`, admin)).json();
    expect(detail.byDay).toEqual([expect.objectContaining({ day: today, trips: 2, faresPesewas: 2200, topUpsPesewas: 2000 })]);
    expect(detail.period).toMatchObject({ riders: 2, topUpsPesewas: 2000, incomePesewas: 4200 });
  });

  it("refuses riders and drivers", async () => {
    const d = await driver("Not Admin");
    expect((await get("/admin/payouts?from=2026-11-23T00:00:00.000Z&to=2026-11-24T00:00:00.000Z", d)).statusCode).toBe(403);
    expect((await post("/admin/payouts", { driverId: d.id, amountPesewas: 100, paidOn: day(0), method: "CASH" }, d)).statusCode).toBe(403);
  });
});

describe("GET /admin/kpis", () => {
  it("answers every KPI, series and the funnel for a period", async () => {
    const res = await get(`/admin/kpis?from=${encodeURIComponent(`${day(-6)}T00:00:00.000Z`)}&to=${encodeURIComponent(`${day(1)}T00:00:00.000Z`)}`, admin);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.kpis)).toEqual(
      expect.arrayContaining(["registeredRiders", "newSignups", "ridersRequested", "ridersServed", "repeatRiders", "requests", "completedRides", "completionPct", "noDriverPct", "gmvPesewas", "ridersPerCarTrip", "activeDrivers", "medianAcceptSeconds"]),
    );
    expect(body.daily).toHaveLength(7);
    expect(body.byHour).toHaveLength(24);
    expect(body.funnel.map((f: { step: string }) => f.step)).toEqual(["Registered", "Requested a ride", "Got a ride", "2+ rides"]);
    // No names or phones in the KPIs.
    expect(JSON.stringify(body)).not.toMatch(/\+233/);
  });

  it("refuses a bad period", async () => {
    expect((await get("/admin/kpis?from=nope&to=nope", admin)).statusCode).toBe(400);
  });
});

describe("commission reconciliation: earned = paid + waived + still owed (− paid ahead)", () => {
  const at = (iso: string) => new Date(`2026-11-${iso}Z`);
  const credit = (id: string, when: string, kind: "PAYMENT" | "WAIVER", amount: number, reversesId: string | null = null) => ({
    id,
    at: at(when),
    kind,
    amount,
    reversesId,
    createdAt: at(when),
  });

  it("a launch 'waive all' over trips that were later waived anyway forgives nothing twice", () => {
    // Owed 3.00 from before launch; launch-week trips (3.30) are waived trips now; "waive all" gave 6.30 on 27 Nov.
    const b = walkBalance("d", [{ at: at("20T10:00:00"), amount: 300 }], [credit("w1", "27T18:00:00", "WAIVER", 630)], 330);
    expect(b).toMatchObject({ earnedPesewas: 630, commissionWaivedPesewas: 330, waivedPesewas: 300, paidPesewas: 0, balancePesewas: 0 });
    // The bug: waived (trips 3.30 + credit 6.30 = 9.60) was more than all commission ever earned (6.30).
    expect(b.commissionWaivedPesewas + b.waivedPesewas).toBeLessThanOrEqual(b.earnedPesewas);
    expect(reconciles(b)).toBe(true);
  });

  it("a waiver forgives only what is owed then; reversing it brings back exactly that", () => {
    const charges = [
      { at: at("20T10:00:00"), amount: 200 },
      { at: at("22T10:00:00"), amount: 100 },
    ];
    const credits = [credit("w1", "21T00:00:00", "WAIVER", 500), credit("r1", "23T00:00:00", "WAIVER", -500, "w1")];
    const b = walkBalance("d", charges, credits, 0);
    expect(b).toMatchObject({ earnedPesewas: 300, waivedPesewas: 0, balancePesewas: 300 });
    expect(b.oldestUnpaidAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    expect(reconciles(b)).toBe(true);
  });

  it("payments beyond what is owed are paid ahead, and cover the next trips", () => {
    const b = walkBalance("d", [{ at: at("25T10:00:00"), amount: 105 }], [credit("p1", "24T10:00:00", "PAYMENT", 500)], 0);
    expect(b).toMatchObject({ earnedPesewas: 105, paidPesewas: 500, balancePesewas: -395, oldestUnpaidAt: null });
    expect(reconciles(b)).toBe(true);
  });

  it("on the admin site: every driver's row and the totals reconcile after 'waive all' plus a back-dated waiver", async () => {
    const d = await driver("Reconcile Driver");
    await pastCommission(d, 300, new Date(Date.now() - 10 * 86_400_000));
    await pastCommission(d, 105, new Date(Date.now() - 2 * 86_400_000));
    await pastCommission(d, 225, new Date(Date.now() - 1 * 86_400_000));
    await prisma.driverCashPayment.create({ data: { driverUserId: d.id, amountPesewas: 50, method: "CASH", paidAt: new Date(Date.now() - 9 * 86_400_000), recordedBy: admin.id } });
    // Waive the driver's whole balance (580), THEN back-date the commission waiver over the last 3 days.
    const all = await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 580, reason: "Commission-free launch" }, admin);
    expect(all.statusCode).toBe(201);
    expect((await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(-3) })).statusCode).toBe(200);
    await setTerms({ rateBps: 1500, waived: false });

    const b = await driverBalance(prisma, d.id);
    // Earned 6.30 = paid 0.50 + waived trips 3.30 + waived balance 2.50 + still owed 0.
    expect(b).toMatchObject({ earnedPesewas: 630, paidPesewas: 50, commissionWaivedPesewas: 330, waivedPesewas: 250, balancePesewas: 0 });
    expect(reconciles(b)).toBe(true);

    clearAdminCache();
    const cash = (await get(`/admin/cash?from=${encodeURIComponent(`${day(-30)}T00:00:00.000Z`)}&to=${encodeURIComponent(`${day(1)}T00:00:00.000Z`)}`, admin)).json();
    const row = cash.drivers.find((r: { userId: string }) => r.userId === d.id);
    expect(row).toMatchObject({ earnedPesewas: 630, allPaidPesewas: 50, allWaivedPesewas: 580, balancePesewas: 0 });
    const t = cash.reconciliation;
    expect(t.waivedPesewas).toBeLessThanOrEqual(t.earnedPesewas);
    expect(t.earnedPesewas).toBe(t.paidPesewas + t.waivedPesewas + t.adjustedPesewas + t.stillOwedPesewas - t.paidAheadPesewas);
  });
});

describe("driver earnings for any range", () => {
  it("today, a week and all time give each range's fares, commission waived/charged, top-ups and income", async () => {
    const d = await driver("Range Driver");
    await setTerms({ rateBps: 1500, waived: true, waivedFromDay: day(-5) });
    await completeTrip(d, 700, new Date(Date.now() - 3 * 86_400_000));
    await completeTrip(d, 1500);
    await setTerms({ rateBps: 2000, waived: false });
    await completeTrip(d, 1000);
    await post("/admin/payouts", { driverId: d.id, amountPesewas: 3000, paidOn: day(0), method: "CASH" }, admin);
    clearAdminCache();
    const range = (from: string, to: string) => `from=${encodeURIComponent(`${from}T00:00:00.000Z`)}&to=${encodeURIComponent(`${to}T00:00:00.000Z`)}`;

    const today = (await get(`/admin/drivers/${d.id}?${range(day(0), day(1))}`, admin)).json();
    expect(today.period).toMatchObject({ trips: 2, faresPesewas: 2500, commissionPesewas: 200, commissionWaivedPesewas: 225, topUpsPesewas: 3000, incomePesewas: 2500 - 200 + 3000 });

    const week = (await get(`/admin/drivers/${d.id}?${range(day(-6), day(1))}`, admin)).json();
    expect(week.period).toMatchObject({ trips: 3, faresPesewas: 3200, commissionPesewas: 200, commissionWaivedPesewas: 330, topUpsPesewas: 3000 });
    // Only days with something in them.
    expect(week.byDay.map((b: { day: string }) => b.day)).toEqual([day(-3), day(0)]);

    const allTime = (await get(`/admin/drivers/${d.id}?${range("2026-01-01", day(1))}`, admin)).json();
    expect(allTime.period).toMatchObject({ trips: 3, faresPesewas: 3200 });

    const list = (await get(`/admin/drivers?${range(day(0), day(1))}`, admin)).json();
    expect(list.drivers.find((r: { userId: string }) => r.userId === d.id)).toMatchObject({ trips: 2, faresPesewas: 2500, commissionDuePesewas: 200, commissionWaivedPesewas: 225, incomePesewas: 5300 });
  });
});

describe("admin accounts", () => {
  it("lists admins and renames one (audit-logged); refuses non-admins and tiny names", async () => {
    const other = await user("ADMIN", "Wrong Name");
    const list = (await get("/admin/admins", admin)).json();
    expect(list.admins.find((a: { id: string }) => a.id === admin.id)).toMatchObject({ isMe: true });
    expect((await app.inject({ method: "PATCH", url: `/admin/admins/${other.id}`, headers: auth(admin), payload: { name: "  Ama   Owusu " } })).json()).toMatchObject({ admin: { name: "Ama Owusu" } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).name).toBe("Ama Owusu");
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "admin.rename", reason: "Wrong Name → Ama Owusu" } })).toBe(1);
    expect((await app.inject({ method: "PATCH", url: `/admin/admins/${other.id}`, headers: auth(admin), payload: { name: "A" } })).statusCode).toBe(400);
    const d = await driver("Some Driver");
    expect((await app.inject({ method: "PATCH", url: `/admin/admins/${d.id}`, headers: auth(admin), payload: { name: "Hacker" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/admin/admins/${other.id}`, headers: auth(d), payload: { name: "Hacker" } })).statusCode).toBe(403);
  });
});
