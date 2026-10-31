/**
 * The admin dashboard v2 endpoints, on one seeded week (Mon 6 – Sun 12
 * January 2020, long before any other test's rows) with: a ride alone and a
 * shared ride with a cheaper seat and a cancelled seat, a rider cancelling
 * before a driver took it, a driver cancelling after, a request no driver
 * took, an online session spanning midnight, offers answered every way,
 * cash payments with a reversal and a part payment, and an SOS.
 *
 * Pins the numbers in docs/admin-metrics.md, the cache, the audit rows,
 * phone masking, schema refusals, ADMIN + allowlist, suspension refusing
 * go-online, and the live map from memory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken } from "../services/auth/tokens";
import { getTestZones } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { clearAdminCache } from "../services/admin/cache";
import { noteRequestOffered, resetLiveRequestsForTests } from "../services/admin/liveRequests";
import { recordDriverPosition, resetLivePositionsForTests } from "../services/zones/livePositions";

let app: FastifyInstance;
const H = 60 * 60_000;
const MON = Date.parse("2020-01-06T00:00:00.000Z");
const at = (day: number, hour: number, minute = 0, second = 0) => new Date(MON + day * 24 * H + hour * H + minute * 60_000 + second * 1000);
const WEEK = `from=${at(0, 0).toISOString()}&to=${at(7, 0).toISOString()}`;
const MONDAY = `from=${at(0, 0).toISOString()}&to=${at(1, 0).toISOString()}`;

const userIds: string[] = [];
const rideIds: string[] = [];
let admin: User;
let r1: User, r2: User, r3: User;
let d1: User, d2: User, d3: User;
let d1DriverId: string, d2DriverId: string;
const ride: Record<string, string> = {};
let sosId: string;

const auth = (u: User) => ({ authorization: `Bearer ${signAccessToken({ userId: u.id, role: u.role })}` });
const get = (url: string, as: User = admin) => app.inject({ method: "GET", url, headers: auth(as) });
const post = (url: string, payload: object, as: User = admin) => app.inject({ method: "POST", url, headers: auth(as), payload });

async function user(role: "RIDER" | "DRIVER" | "ADMIN", name: string) {
  const u = await prisma.user.create({ data: { phone: uniqueGhanaPhone(), name, role } });
  userIds.push(u.id);
  return u;
}

async function driver(name: string, approved = true) {
  const u = await user("DRIVER", name);
  const d = await prisma.driver.create({
    data: { userId: u.id, carMake: "Toyota", carModel: "Vitz", carColor: "Green", plate: `GT ${Math.floor(Math.random() * 9000) + 1000}-30`, isApproved: approved },
  });
  return { u, driverId: d.id };
}

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: new DummyOtpService(), paymentService: new DummyPaymentService() });
  await app.ready();

  const { pickup, dropoff } = await getTestZones();
  admin = await user("ADMIN", "Test Admin");
  [r1, r2, r3] = [await user("RIDER", "Ama Owusu"), await user("RIDER", "Yaw Boateng"), await user("RIDER", "Efua Mensah")];
  ({ u: d1, driverId: d1DriverId } = await driver("Kwame Asante"));
  ({ u: d2, driverId: d2DriverId } = await driver("Kofi Darko"));
  ({ u: d3 } = await driver("Akosua Pending", false));

  const base = { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id };
  const make = async (
    key: string,
    data: Record<string, unknown>,
    seats: Array<{ riderId: string; status: "WAITING" | "DROPPED_OFF" | "CANCELLED" | "PICKED_UP"; lockedFare: number; fareCharged?: number }>,
  ) => {
    const created = await prisma.ride.create({
      data: {
        ...base,
        riderId: seats[0]!.riderId,
        type: "LONE",
        ...data,
        passengers: { create: seats.map((s) => ({ ...base, ...s })) },
      } as never,
    });
    ride[key] = created.id;
    rideIds.push(created.id);
  };

  // 1. Ride alone, Monday 5 pm: matched after 60 s, GH₵15, commission GH₵2.25.
  await make("alone", { driverId: d1.id, status: "COMPLETED", createdAt: at(0, 17), matchedAt: at(0, 17, 1), completedAt: at(0, 17, 20) }, [
    { riderId: r1.id, status: "PICKED_UP", lockedFare: 1500 },
  ]);
  await prisma.commissionLedger.create({ data: { driverUserId: d1.id, rideId: ride.alone!, amountPesewas: 225, createdAt: at(0, 17, 20) } });
  // 2. Shared, Tuesday 6 pm: matched after 120 s; seats GH₵7 and GH₵6 (charged less), a cancelled seat pays nothing: GH₵13, commission GH₵1.95.
  await make("shared", { driverId: d1.id, type: "SHARED", status: "COMPLETED", createdAt: at(1, 18), matchedAt: at(1, 18, 2), completedAt: at(1, 18, 30) }, [
    { riderId: r1.id, status: "DROPPED_OFF", lockedFare: 700 },
    { riderId: r2.id, status: "DROPPED_OFF", lockedFare: 700, fareCharged: 600 },
    { riderId: r3.id, status: "CANCELLED", lockedFare: 700 },
  ]);
  await prisma.commissionLedger.create({ data: { driverUserId: d1.id, rideId: ride.shared!, amountPesewas: 195, createdAt: at(1, 18, 30) } });
  // 3. Rider cancels before a driver took it, Wednesday 9 am.
  await make("riderCancel", { status: "CANCELLED", cancelReason: "RIDER_CANCELLED", riderCancelReason: "PRICE", createdAt: at(2, 9), cancelledAt: at(2, 9, 1) }, [
    { riderId: r2.id, status: "CANCELLED", lockedFare: 1500 },
  ]);
  // 4. Driver cancels after taking it, Thursday 10 am.
  await make("driverCancel", { driverId: d2.id, status: "CANCELLED", cancelReason: "DRIVER_BACKED_OUT", createdAt: at(3, 10), matchedAt: at(3, 10, 0, 30), cancelledAt: at(3, 10, 5) }, [
    { riderId: r3.id, status: "CANCELLED", lockedFare: 1500 },
  ]);
  // 5. Nobody took it, Friday 5 pm.
  await make("noDriver", { status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE", createdAt: at(4, 17), noDriverFoundAt: at(4, 17, 1, 30), cancelledAt: at(4, 17, 3) }, [
    { riderId: r1.id, status: "CANCELLED", lockedFare: 1500 },
  ]);
  // 6. Ride alone by the second driver, Friday 6 pm: matched after 30 s.
  await make("alone2", { driverId: d2.id, status: "COMPLETED", createdAt: at(4, 18), matchedAt: at(4, 18, 0, 30), completedAt: at(4, 18, 15) }, [
    { riderId: r2.id, status: "PICKED_UP", lockedFare: 1500 },
  ]);
  await prisma.commissionLedger.create({ data: { driverUserId: d2.id, rideId: ride.alone2!, amountPesewas: 225, createdAt: at(4, 18, 15) } });

  // Online: Kwame Monday 10 pm – Tuesday 2 am (across midnight); Kofi Friday 4–7 pm.
  await prisma.driverOnlineSession.createMany({
    data: [
      { driverUserId: d1.id, startedAt: at(0, 22), endedAt: at(1, 2), endReason: "OFFLINE" },
      { driverUserId: d2.id, startedAt: at(4, 16), endedAt: at(4, 19), endReason: "OFFLINE" },
    ],
  });
  // Offers: Kwame accepts both his (4 s, 6 s) and saw the no-driver one expire; Kofi declines (2 s), times out, accepts (8 s).
  const offer = (rideKey: string, d: User, outcome: string, seconds: number, offeredAt: Date) => ({
    rideId: ride[rideKey]!,
    driverUserId: d.id,
    offeredAt,
    outcome: outcome as never,
    decidedAt: new Date(offeredAt.getTime() + seconds * 1000),
  });
  await prisma.rideOffer.createMany({
    data: [
      offer("alone", d1, "ACCEPTED", 4, at(0, 17)),
      offer("alone", d2, "DECLINED", 2, at(0, 17)),
      offer("shared", d1, "ACCEPTED", 6, at(1, 18)),
      offer("shared", d2, "TIMED_OUT", 15, at(1, 18)),
      offer("noDriver", d1, "EXPIRED", 90, at(4, 17)),
      offer("alone2", d2, "ACCEPTED", 8, at(4, 18)),
    ],
  });
  // Ratings: one low (2 stars, with a comment) for Kofi.
  await prisma.rating.create({ data: { rideId: ride.alone2!, raterId: r2.id, rateeId: d2.id, stars: 2, comment: "Drove too fast", createdAt: at(4, 18, 20) } });
  // An SOS on the shared ride.
  sosId = (
    await prisma.sosEvent.create({
      data: { rideId: ride.shared!, riderId: r1.id, rideStatus: "IN_PROGRESS", createdAt: at(1, 18, 10), hasContact: true, smsDelivered: true, supportNotified: true },
    })
  ).id;
  // A trail for Kwame on Monday.
  await prisma.driverLocationPoint.createMany({
    data: [0, 1, 2].map((i) => ({ driverUserId: d1.id, latitude: 5.65 + i * 0.001, longitude: -0.187, recordedAt: at(0, 22, i), onTrip: false })),
  });
});

beforeEach(() => {
  clearAdminCache();
  config.adminPhoneAllowlist.phones.splice(0);
});

afterAll(async () => {
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds }, reversesId: { not: null } } });
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.commissionLedger.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.rating.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actor: admin.id } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe("Overview", () => {
  it("Monday: one request, one trip alone (GH₵15, 15% GH₵2.25), requests and drivers online per hour", async () => {
    const res = await get(`/admin/overview?${MONDAY}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests).toMatchObject({ count: 1, previousCount: 0, gotDriver: 1 });
    expect(body.completed).toEqual({ trips: 1, sharedTrips: 0, faresPesewas: 1500, commissionPesewas: 225 });
    expect(body.hourly.requests[17]).toBe(1);
    expect(body.hourly.driversOnline.slice(21, 24)).toEqual([0, 1, 1]);
    expect(body.noDriver.count).toBe(0);
  });

  it("the week: six requests, three trips, the no-driver request at 5 pm", async () => {
    const body = (await get(`/admin/overview?${WEEK}`)).json();
    expect(body.requests.count).toBe(6);
    expect(body.completed).toEqual({ trips: 3, sharedTrips: 1, faresPesewas: 1500 + 1300 + 1500, commissionPesewas: 225 + 195 + 225 });
    expect(body.noDriver).toMatchObject({ count: 1, firstHour: 17, lastHour: 17 });
  });

  it("refuses a missing or backwards period", async () => {
    expect((await get("/admin/overview")).statusCode).toBe(400);
    expect((await get(`/admin/overview?from=${at(1, 0).toISOString()}&to=${at(0, 0).toISOString()}`)).statusCode).toBe(400);
  });
});

describe("Supply & demand", () => {
  it("requests, got a driver, median time to a driver, no driver, heat grid, per-zone rows", async () => {
    const body = (await get(`/admin/supply-demand?${WEEK}`)).json();
    expect(body).toMatchObject({ requests: 6, gotDriver: 4, noDriver: 1 });
    expect(body.gotDriverRate).toBeCloseTo(4 / 6);
    // Waits: 60 s, 120 s, 30 s, 30 s → median 45 s.
    expect(body.medianTimeToDriverMs).toBe(45_000);
    expect(body.heat.noDriver[4][17]).toBe(1);
    expect(body.heat.requests[0][17]).toBe(1);
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]).toMatchObject({ requests: 6, noDriver: 1 });
    // Kwame online Mon 22:00 – Tue 02:00: one driver-hour in each of 22, 23, 0, 1.
    expect(body.hourly.driverHours[22]).toBe(1);
    expect(body.hourly.driverHours[0]).toBe(1);
  });

  it("is cached for 60 s per period: a new request shows only once the cache is cleared", async () => {
    const before = (await get(`/admin/supply-demand?${WEEK}`)).json().requests;
    const { pickup, dropoff } = await getTestZones();
    const extra = await prisma.ride.create({ data: { riderId: r3.id, type: "LONE", status: "REQUESTED", pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, createdAt: at(5, 12) } });
    rideIds.push(extra.id);
    expect((await get(`/admin/supply-demand?${WEEK}`)).json().requests).toBe(before);
    clearAdminCache();
    expect((await get(`/admin/supply-demand?${WEEK}`)).json().requests).toBe(before + 1);
    await prisma.ride.delete({ where: { id: extra.id } });
  });
});

describe("Cancellations", () => {
  it("counts who cancelled and when, and filters the rides by who", async () => {
    const body = (await get(`/admin/cancellations?${WEEK}`)).json();
    expect(body).toMatchObject({ cancellations: 3, requests: 6, byWho: { rider: 1, driver: 1, system: 1 }, beforeMatch: 2, afterMatch: 1 });
    expect(body.rate).toBeCloseTo(0.5);
    expect(body.reasons.map((r: { label: string }) => r.label)).toContain("Driver cancelled");
    const drivers = (await get(`/admin/cancellations?${WEEK}&who=driver`)).json();
    expect(drivers.rides.map((r: { id: string }) => r.id)).toEqual([ride.driverCancel]);
    expect((await get(`/admin/cancellations?${WEEK}&who=everyone`)).statusCode).toBe(400);
  });
});

describe("Drivers", () => {
  it("trips, hours online (across midnight), earned (85%), acceptance and reply time", async () => {
    const body = (await get(`/admin/drivers?${WEEK}`)).json();
    const kwame = body.drivers.find((d: { userId: string }) => d.userId === d1.id);
    const kofi = body.drivers.find((d: { userId: string }) => d.userId === d2.id);
    const pending = body.drivers.find((d: { userId: string }) => d.userId === d3.id);
    expect(kwame).toMatchObject({ trips: 2, hoursOnlineMs: 4 * H, earnedPesewas: 1500 + 1300 - 225 - 195, acceptanceRate: 1, avgReplyMs: 5000 });
    expect(kofi).toMatchObject({ trips: 1, hoursOnlineMs: 3 * H, earnedPesewas: 1500 - 225, rating: 2 });
    expect(kofi.acceptanceRate).toBeCloseTo(1 / 3);
    expect(kofi.avgReplyMs).toBe(5000);
    expect(pending).toMatchObject({ isApproved: false, acceptanceRate: null });
    expect(kwame.maskedPhone).toMatch(/^\+233\*{5}\d{3}$/);
    expect(JSON.stringify(body)).not.toContain(d1.phone);
  });

  it("one driver: Monday clips the midnight session to 2 hours; the trail days and the balance", async () => {
    const body = (await get(`/admin/drivers/${d1DriverId}?${MONDAY}`)).json();
    expect(body.driver).toMatchObject({ userId: d1.id, phone: d1.phone, plate: expect.any(String) });
    expect(body.period).toMatchObject({ trips: 1, hoursOnlineMs: 2 * H, earnedPesewas: 1275 });
    // Trails are kept 90 days: 2020 is long gone (the trail itself is still read below).
    expect(body.trailDays).toEqual([]);
  });

  it("the location trail is one day, and viewing it is audit-logged", async () => {
    const res = await get(`/admin/drivers/${d1.id}/trail?day=2020-01-06`);
    expect(res.statusCode).toBe(200);
    expect(res.json().points).toHaveLength(3);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "driver.trail.view", target: d1DriverId } })).toBe(1);
    expect((await get(`/admin/drivers/${d1.id}/trail?day=yesterday`)).statusCode).toBe(400);
  });

  it("suspending needs a reason, takes the driver offline and refuses going online until lifted", async () => {
    expect((await post(`/admin/drivers/${d2DriverId}/suspend`, {})).statusCode).toBe(400);
    await prisma.driver.update({ where: { id: d2DriverId }, data: { isOnline: true } });
    expect((await post(`/admin/drivers/${d2DriverId}/suspend`, { reason: "Speeding complaint" })).statusCode).toBe(200);
    expect(await prisma.driver.findUniqueOrThrow({ where: { id: d2DriverId } })).toMatchObject({ isOnline: false, suspendedReason: "Speeding complaint", suspendedBy: admin.id });
    expect((await post(`/admin/drivers/${d2DriverId}/suspend`, { reason: "again" })).statusCode).toBe(409);

    const online = await app.inject({ method: "PATCH", url: "/driver/availability", headers: auth(d2), payload: { isOnline: true } });
    expect(online.statusCode).toBe(403);
    expect(online.json().code).toBe("DRIVER_SUSPENDED");

    expect((await post(`/admin/drivers/${d2DriverId}/unsuspend`, { reason: "Spoke to him" })).statusCode).toBe(200);
    const actions = (await prisma.adminAuditLog.findMany({ where: { actor: admin.id, target: d2DriverId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["driver.suspend", "driver.unsuspend"]));
    expect((await get(`/admin/drivers?${WEEK}`)).json().counts.suspended).toBe(0);
  });
});

describe("Cash owed", () => {
  it("balance = commission on completed cash rides − payments; partial payments, reversals once, audit rows", async () => {
    const week = () => get(`/admin/cash?${WEEK}`).then((r) => r.json());
    const row = (body: { drivers: Array<{ userId: string }> }, u: User) => body.drivers.find((d) => d.userId === u.id) as Record<string, unknown>;

    let body = await week();
    expect(row(body, d1)).toMatchObject({ owedInPeriodPesewas: 420, paidInPeriodPesewas: 0, balancePesewas: 420, status: "NOT_PAID" });
    expect(row(body, d2)).toMatchObject({ balancePesewas: 225, status: "NOT_PAID" });

    // GH₵3 on Wednesday, recorded by mistake, then reversed; then GH₵1 for real.
    const first = await post("/admin/cash/payments", { driverId: d1.id, amountPesewas: 300, method: "CASH", note: "Wrong driver", paidAt: at(2, 12).toISOString() });
    expect(first.statusCode).toBe(201);
    const paymentId = first.json().payment.id;
    const reversed = await post(`/admin/cash/payments/${paymentId}/reverse`, { reason: "Recorded against the wrong driver" });
    expect(reversed.statusCode).toBe(201);
    expect((await post(`/admin/cash/payments/${paymentId}/reverse`, { reason: "again" })).statusCode).toBe(409);
    expect((await post(`/admin/cash/payments/${reversed.json().reversal.id}/reverse`, { reason: "undo" })).statusCode).toBe(409);
    expect((await post("/admin/cash/payments", { driverId: d1DriverId, amountPesewas: 100, method: "MOMO", paidAt: at(3, 12).toISOString() })).statusCode).toBe(201);

    body = await week();
    // The reversal is dated now (outside that week), so the week shows +300 +100; the balance counts everything.
    expect(row(body, d1)).toMatchObject({ balancePesewas: 320, status: "PART_PAID" });
    const ledger = (await get(`/admin/cash/payments?driverId=${d1.id}`)).json();
    expect(ledger.payments.map((p: { amountPesewas: number }) => p.amountPesewas).sort()).toEqual([-300, 100, 300].sort());
    expect(ledger.payments.find((p: { id: string }) => p.id === paymentId).reversedBy.reason).toBe("Recorded against the wrong driver");
    expect(ledger.payments[0].recordedBy.name).toBe("Test Admin");

    const actions = (await prisma.adminAuditLog.findMany({ where: { actor: admin.id, action: { startsWith: "cash." } } })).map((a) => a.action);
    expect(actions.sort()).toEqual(["cash.payment.record", "cash.payment.record", "cash.payment.reverse"]);
  });

  it("refuses bad payments by schema: no amount, a negative one, an unknown method", async () => {
    expect((await post("/admin/cash/payments", { driverId: d1.id, method: "CASH" })).statusCode).toBe(400);
    expect((await post("/admin/cash/payments", { driverId: d1.id, amountPesewas: -5, method: "CASH" })).statusCode).toBe(400);
    expect((await post("/admin/cash/payments", { driverId: d1.id, amountPesewas: 5, method: "BITCOIN" })).statusCode).toBe(400);
    expect((await post("/admin/cash/payments", { driverId: d1.id, amountPesewas: 5, method: "CASH", paidAt: at(9000, 0).toISOString() })).statusCode).toBe(400);
  });
});

describe("Rides", () => {
  it("lists with masked phones, filters by type and rider phone, and paginates", async () => {
    const list = await get(`/admin/rides?${WEEK}&type=SHARED`);
    expect(list.statusCode).toBe(200);
    expect(list.json().rides.map((r: { id: string }) => r.id)).toEqual([ride.shared]);
    expect(list.json().rides[0].rider.maskedPhone).toMatch(/\*{5}/);
    expect(list.body).not.toContain(r1.phone);
    const byPhone = (await get(`/admin/rides?${WEEK}&riderPhone=${encodeURIComponent(r3.phone)}`)).json();
    expect(byPhone.rides.map((r: { id: string }) => r.id).sort()).toEqual([ride.shared, ride.driverCancel].sort());
    const paged = (await get(`/admin/rides?${WEEK}&pageSize=2&page=2`)).json();
    expect(paged).toMatchObject({ total: 6, page: 2, pageSize: 2 });
    expect(paged.rides).toHaveLength(2);
  });

  it("an export over 200 rows needs a short period", async () => {
    expect((await get("/admin/rides?pageSize=1000")).statusCode).toBe(400);
    expect((await get(`/admin/rides?${WEEK}&pageSize=1000`)).statusCode).toBe(200);
  });

  it("one ride in full: timeline, offers, seat fares, SOS", async () => {
    const body = (await get(`/admin/rides/${ride.shared}`)).json();
    expect(body.seats.map((s: { farePesewas: number | null }) => s.farePesewas)).toEqual([700, 600, null]);
    expect(body.ride.fareTotal).toBe(1300);
    expect(body.offers).toHaveLength(2);
    expect(body.timeline.map((t: { kind: string }) => t.kind)).toEqual(["requested", "offer", "offer", "matched", "sos", "completed"]);
    expect(body.sos).toHaveLength(1);
    expect((await get("/admin/rides/does-not-exist")).statusCode).toBe(404);
  });
});

describe("Riders", () => {
  it("totals, masked list, and the full number only in the detail", async () => {
    const body = (await get(`/admin/riders?${WEEK}&q=${encodeURIComponent(r1.phone)}`)).json();
    expect(body.list).toHaveLength(1);
    expect(body.list[0]).toMatchObject({ id: r1.id, rides: 2 });
    expect(JSON.stringify(body.list)).not.toContain(r1.phone);
    const detail = (await get(`/admin/riders/${r1.id}`)).json();
    expect(detail.rider.phone).toBe(r1.phone);
    expect(detail.stats.completed).toBe(2);
    expect(detail.sos).toHaveLength(1);
  });
});

describe("Safety", () => {
  it("open SOS first; marking handled needs a note, happens once and is audit-logged", async () => {
    const before = (await get(`/admin/safety?${WEEK}`)).json();
    expect(before.sos.find((s: { id: string }) => s.id === sosId)).toMatchObject({ handledAt: null, smsDelivered: true });
    expect(before.lowRatings.map((r: { comment: string }) => r.comment)).toContain("Drove too fast");
    expect((await post(`/admin/sos/${sosId}/handle`, { note: "" })).statusCode).toBe(400);
    expect((await post(`/admin/sos/${sosId}/handle`, { note: "Called the rider; safe at home" })).statusCode).toBe(200);
    expect((await post(`/admin/sos/${sosId}/handle`, { note: "again" })).statusCode).toBe(409);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "sos.handle", target: sosId } })).toBe(1);
    const after = (await get(`/admin/safety?${WEEK}`)).json();
    expect(after.sos.find((s: { id: string }) => s.id === sosId)).toMatchObject({ handledNote: "Called the rider; safe at home", handledBy: { name: "Test Admin" } });
  });
});

describe("Live map", () => {
  it("comes from memory: positions, waiting requests with offer counts", async () => {
    resetLivePositionsForTests();
    resetLiveRequestsForTests();
    await prisma.driver.update({ where: { id: d1DriverId }, data: { isOnline: true } });
    recordDriverPosition(d1.id, { latitude: 5.6505, longitude: -0.1865 });
    noteRequestOffered(
      { rideId: "live-ride", riderId: r2.id, riderName: "Yaw Boateng", type: "LONE", requestedAt: Date.now() - 60_000, pickup: { latitude: 5.65, longitude: -0.19, label: "Night Market" }, pickupZoneId: "z", pickupLabel: "Night Market", dropoffLabel: "Akuafo Hall" },
      [d1.id, d2.id],
    );
    const body = (await get("/admin/live")).json();
    expect(body.drivers.find((d: { userId: string }) => d.userId === d1.id)).toMatchObject({ status: "WAITING", position: { latitude: 5.6505, live: true } });
    expect(body.requests).toEqual([expect.objectContaining({ rideId: "live-ride", offeredTo: 2, declined: 0 })]);
    expect(body.counts.ridersWaiting).toBe(1);
    await prisma.driver.update({ where: { id: d1DriverId }, data: { isOnline: false } });
    resetLiveRequestsForTests();
  });
});

describe("summary, search, audit, system", () => {
  it("badges, search by phone and ride id, audit log with masked numbers", async () => {
    const summary = (await get("/admin/summary")).json();
    expect(summary).toMatchObject({ database: "ok" });
    expect(summary.driversNeedingApproval).toBeGreaterThanOrEqual(1);
    const byPhone = (await get(`/admin/search?q=${encodeURIComponent(d1.phone)}`)).json();
    expect(byPhone.results[0]).toMatchObject({ kind: "driver", id: d1DriverId });
    const byRide = (await get(`/admin/search?q=${ride.alone}`)).json();
    expect(byRide.results.some((r: { kind: string; id: string }) => r.kind === "ride" && r.id === ride.alone)).toBe(true);
    await prisma.adminAuditLog.create({ data: { actor: admin.id, action: "rate_limit.clear", target: "x", reason: `${r1.phone}: nothing in use` } });
    const audit = (await get("/admin/audit?action=rate_limit")).json();
    expect(audit.entries[0].reason).not.toContain(r1.phone);
    expect(audit.admins.map((a: { id: string }) => a.id)).toContain(admin.id);
    const mine = (await get(`/admin/audit?actor=${admin.id}`)).json();
    expect(mine.entries.every((e: { actor: { id: string } | null }) => e.actor?.id === admin.id)).toBe(true);
    expect((await get("/admin/system")).json()).toHaveProperty("server.startedAt");
  });

  it("refuses riders, and admins whose number isn't on the allowlist", async () => {
    for (const url of ["/admin/summary", `/admin/overview?${WEEK}`, "/admin/live", `/admin/cash?${WEEK}`]) {
      expect((await get(url, r1)).statusCode, url).toBe(403);
    }
    config.adminPhoneAllowlist.phones.push(uniqueGhanaPhone());
    for (const url of ["/admin/summary", `/admin/drivers?${WEEK}`, `/admin/safety?${WEEK}`]) {
      expect((await get(url)).statusCode, url).toBe(403);
    }
  });
});
