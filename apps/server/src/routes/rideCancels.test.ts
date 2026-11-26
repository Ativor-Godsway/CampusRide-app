/**
 * Ride cancel fixes (2026-11-23), against the real routes and database:
 *
 * 1. A rider added to another driver's car can cancel their own seat — by
 *    their own (merged) request's id or by the car's id — and nobody else's.
 * 2. A driver's "Cancel pickup" sends the rider straight back to searching
 *    (the same ride when they were alone, a new request when others are in
 *    the car), is recorded with its reason and counts as the driver's
 *    cancellation. "Rider didn't show" is unchanged.
 * 3. An admin can cancel one seat or a whole ride, with a reason, audit-logged.
 *
 * Old-app compatibility: driver builds without reasons (no body: WAITING
 * only), rider builds that read only the ride's status and their seat.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { prisma } from "../db/prisma";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, getTestZones } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { clearAdminCache } from "../services/admin/cache";
import * as rideSocket from "../realtime/rideSocket";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const userIds: string[] = [];
const driverIds: string[] = [];
let admin: User;

type Sent = { to: "ride" | "rider"; id: string; event: string; payload: Record<string, unknown> };
let sent: Sent[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: new DummyOtpService(), paymentService: new DummyPaymentService() });
  await app.ready();
  admin = await prisma.user.create({ data: { phone: uniqueGhanaPhone(), name: "Test Admin", role: "ADMIN" } });
  userIds.push(admin.id);
});

afterEach(async () => {
  vi.restoreAllMocks();
  sent = [];
  clearAdminCache();
  const riders = userIds.filter((u) => u !== admin.id);
  const rides = await prisma.ride.findMany({
    where: { OR: [{ riderId: { in: riders } }, { passengers: { some: { riderId: { in: riders } } } }] },
    select: { id: true },
  });
  const rideIds = rides.map((r) => r.id);
  await prisma.driverCancellation.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actor: admin.id } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: riders } } });
  userIds.splice(0, userIds.length, admin.id);
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: admin.id } });
  await app.close();
});

function caller(userId: string, role: "RIDER" | "DRIVER" | "ADMIN") {
  const headers = { authorization: `Bearer ${signAccessToken({ userId, role })}` };
  return (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
}
const asAdmin = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) => caller(admin.id, "ADMIN")(method, url, payload);

async function rider(name: string) {
  const user = await prisma.user.create({ data: { phone: uniqueGhanaPhone(), name, role: "RIDER" } });
  userIds.push(user.id);
  return { id: user.id, as: caller(user.id, "RIDER") };
}
type Rider = Awaited<ReturnType<typeof rider>>;

async function driver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(user.id);
  return { id: user.id, as: caller(user.id, "DRIVER") };
}

async function request(r: Rider, type: "SHARED" | "LONE" = "SHARED") {
  const { pickup, dropoff } = await getTestZones();
  const res = await r.as("POST", "/rides", { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type, paymentMethod: "CASH" });
  expect(res.statusCode).toBe(201);
  return res.json().ride.id as string;
}

function recordEvents() {
  sent = [];
  vi.spyOn(rideSocket, "emitRideEvent").mockImplementation((id, event, payload) => {
    sent.push({ to: "ride", id, event, payload: payload as unknown as Record<string, unknown> });
  });
  vi.spyOn(rideSocket, "emitToRider").mockImplementation((id, event, payload) => {
    sent.push({ to: "rider", id, event, payload: payload as unknown as Record<string, unknown> });
  });
}

/** Owen books Shared, the driver accepts; Mia books Shared and the driver adds her to Owen's car. */
async function sharedCar() {
  const owen = await rider("Owen Host");
  const mia = await rider("Mia Merged");
  const carId = await request(owen);
  const miaRequest = await request(mia);
  const d = await driver();
  expect((await d.as("POST", `/rides/${carId}/claim`)).statusCode).toBe(200);
  expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: miaRequest })).statusCode).toBe(200);
  const seats = await prisma.ridePassenger.findMany({ where: { rideId: carId } });
  const seatOf = (who: Rider) => seats.find((s) => s.riderId === who.id)!.id;
  recordEvents();
  return { owen, mia, carId, miaRequest, d, seatOf };
}

async function seatStatus(seatId: string) {
  return (await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seatId } })).status;
}
async function rideOf(id: string) {
  return prisma.ride.findUniqueOrThrow({ where: { id }, include: { passengers: true } });
}

// ─── 1. Rider cancels their own seat, wherever it lives ─────────────────────

describe("a rider added to another driver's car cancels", () => {
  for (const by of ["their own request's id", "the car's id"] as const) {
    it(`by ${by}: only their seat goes, the car carries on, the driver hears`, async () => {
      const { owen, mia, carId, miaRequest, d, seatOf } = await sharedCar();
      const id = by === "the car's id" ? carId : miaRequest;

      const res = await mia.as("POST", `/rides/${id}/cancel`, { reason: "CHANGED_PLANS" });
      expect(res.statusCode).toBe(200);

      expect(await seatStatus(seatOf(mia))).toBe("CANCELLED");
      expect(await seatStatus(seatOf(owen))).toBe("WAITING");
      const car = await rideOf(carId);
      expect(car.status).toBe("MATCHED");
      expect(car.driverId).toBe(d.id);
      expect(car.occupancy).toBe(1);
      // Her reason is kept on HER request, never on Owen's ride.
      expect(car.riderCancelReason).toBeNull();
      expect((await rideOf(miaRequest)).riderCancelReason).toBe("CHANGED_PLANS");
      // The driver's screen (the car's room) refetches; Mia hears her seat went.
      expect(sent).toContainEqual(expect.objectContaining({ to: "ride", id: carId, event: "ride:status" }));
      expect(sent).toContainEqual(
        expect.objectContaining({ to: "rider", id: mia.id, event: "ride:passenger_status", payload: expect.objectContaining({ status: "CANCELLED" }) }),
      );
      // She can book again straight away.
      expect((await mia.as("GET", "/rides/active")).json().ride).toBeNull();
      // Repeating it is harmless.
      expect((await mia.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(200);
    });
  }

  it("while the car is already on its way (the other rider is aboard)", async () => {
    const { owen, mia, carId, d, seatOf } = await sharedCar();
    expect((await d.as("POST", `/rides/${carId}/passengers/${seatOf(owen)}/arrived`)).statusCode).toBe(200);
    expect((await d.as("POST", `/rides/${carId}/passengers/${seatOf(owen)}/pickup`)).statusCode).toBe(200);
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");

    expect((await mia.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(200);
    expect(await seatStatus(seatOf(mia))).toBe("CANCELLED");
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");
  });

  it("not once picked up", async () => {
    const { mia, carId, d, seatOf } = await sharedCar();
    await d.as("POST", `/rides/${carId}/passengers/${seatOf(mia)}/arrived`);
    await d.as("POST", `/rides/${carId}/passengers/${seatOf(mia)}/pickup`);
    expect((await mia.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(409);
    expect(await seatStatus(seatOf(mia))).toBe("PICKED_UP");
  });

  it("someone else can't cancel it by either id (404, nothing changes)", async () => {
    const { owen, mia, carId, miaRequest, seatOf } = await sharedCar();
    const eve = await rider("Eve Stranger");
    expect((await eve.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(404);
    expect((await eve.as("POST", `/rides/${miaRequest}/cancel`)).statusCode).toBe(404);
    expect(await seatStatus(seatOf(mia))).toBe("WAITING");
    expect(await seatStatus(seatOf(owen))).toBe("WAITING");
    expect((await rideOf(carId)).status).toBe("MATCHED");
  });

  it("the car's booker cancelling leaves the added rider's trip alone", async () => {
    const { owen, mia, carId, seatOf } = await sharedCar();
    expect((await owen.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(200);
    expect(await seatStatus(seatOf(owen))).toBe("CANCELLED");
    expect(await seatStatus(seatOf(mia))).toBe("WAITING");
    expect((await rideOf(carId)).status).toBe("MATCHED");
  });

  it("the last rider waiting in a car that carried others ends the trip as completed", async () => {
    const { owen, mia, carId, d, seatOf } = await sharedCar();
    for (const step of ["arrived", "pickup", "dropoff"]) {
      expect((await d.as("POST", `/rides/${carId}/passengers/${seatOf(owen)}/${step}`)).statusCode).toBe(200);
    }
    expect((await mia.as("POST", `/rides/${carId}/cancel`)).statusCode).toBe(200);
    const car = await rideOf(carId);
    expect(car.status).toBe("COMPLETED");
    await vi.waitFor(async () => expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(1));
  });
});

// ─── 2. Driver cancels a pickup ─────────────────────────────────────────────

describe("driver's Cancel pickup", () => {
  async function loneRide() {
    const ama = await rider("Ama Alone");
    const rideId = await request(ama, "LONE");
    const d = await driver();
    expect((await d.as("POST", `/rides/${rideId}/claim`)).statusCode).toBe(200);
    const seat = (await rideOf(rideId)).passengers[0]!;
    recordEvents();
    return { ama, rideId, d, seatId: seat.id };
  }

  it("alone in the car: the same ride searches again, without this driver, and it's recorded", async () => {
    const { ama, rideId, d, seatId } = await loneRide();
    const res = await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "CAR_PROBLEM", note: " Flat tyre " });
    expect(res.statusCode).toBe(200);

    const ride = await rideOf(rideId);
    expect(ride.status).toBe("REQUESTED");
    expect(ride.driverId).toBeNull();
    expect(ride.broadcastStartedAt!.getTime()).toBeGreaterThan(Date.now() - 10_000);
    expect(ride.passengers[0]!.status).toBe("WAITING");
    expect(ride.passengers[0]!.arrivedAt).toBeNull();
    expect(await prisma.rideRejection.findMany({ where: { rideId } })).toEqual([
      expect.objectContaining({ driverUserId: d.id, reason: "DECLINED" }),
    ]);
    expect(await prisma.driverCancellation.findMany({ where: { rideId } })).toEqual([
      expect.objectContaining({ driverUserId: d.id, riderId: ama.id, reason: "CAR_PROBLEM", note: "Flat tyre", rebookedRideId: null }),
    ]);

    // The rider's app (any build) sees its ride searching again; the driver is free at once.
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ to: "ride", id: rideId, event: "ride:status", payload: expect.objectContaining({ status: "REQUESTED" }) }),
      ),
    );
    const active = (await ama.as("GET", "/rides/active")).json().ride;
    expect(active).toMatchObject({ id: rideId, status: "REQUESTED" });
    expect((await d.as("GET", "/driver/rides/active")).json().ride ?? null).toBeNull();

    // The rider can still cancel it, which ends it as before.
    expect((await ama.as("POST", `/rides/${rideId}/cancel`)).statusCode).toBe(200);
    expect((await rideOf(rideId)).status).toBe("CANCELLED");
  });

  it("from ARRIVED too, and a retry changes nothing (one record)", async () => {
    const { rideId, d, seatId } = await loneRide();
    expect((await d.as("POST", `/rides/${rideId}/passengers/${seatId}/arrived`)).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) {
      expect((await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "RIDER_NOT_RESPONDING" })).statusCode).toBe(200);
    }
    expect(await prisma.driverCancellation.count({ where: { rideId } })).toBe(1);
    expect((await rideOf(rideId)).status).toBe("REQUESTED");
  });

  it("an older driver app (no body) still cancels a WAITING rider — recorded without a reason — but not an ARRIVED one", async () => {
    const first = await loneRide();
    expect((await first.d.as("POST", `/rides/${first.rideId}/passengers/${first.seatId}/cancel`)).statusCode).toBe(200);
    expect(await prisma.driverCancellation.findFirst({ where: { rideId: first.rideId } })).toMatchObject({ reason: null });
    expect((await rideOf(first.rideId)).status).toBe("REQUESTED");

    const second = await loneRide();
    await second.d.as("POST", `/rides/${second.rideId}/passengers/${second.seatId}/arrived`);
    const res = await second.d.as("POST", `/rides/${second.rideId}/passengers/${second.seatId}/cancel`);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("INVALID_PASSENGER_STATE");
  });

  it("only the assigned driver, only before pickup, only known reasons", async () => {
    const { rideId, d, seatId } = await loneRide();
    const other = await driver();
    expect((await other.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "OTHER" })).statusCode).toBe(404);
    expect((await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "BORED" })).statusCode).toBe(400);
    await d.as("POST", `/rides/${rideId}/passengers/${seatId}/arrived`);
    await d.as("POST", `/rides/${rideId}/passengers/${seatId}/pickup`);
    expect((await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "OTHER" })).statusCode).toBe(409);
    expect(await prisma.driverCancellation.count({ where: { rideId } })).toBe(0);
  });

  it("with others in the car: that rider gets a new request (same ends and fare), the car carries on", async () => {
    const { owen, mia, carId, d, seatOf } = await sharedCar();
    const miaSeat = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seatOf(mia) } });

    const res = await d.as("POST", `/rides/${carId}/passengers/${miaSeat.id}/cancel`, { reason: "CANT_REACH_PICKUP" });
    expect(res.statusCode).toBe(200);

    expect(await seatStatus(miaSeat.id)).toBe("CANCELLED");
    expect(await seatStatus(seatOf(owen))).toBe("WAITING");
    expect((await rideOf(carId)).status).toBe("MATCHED");

    const record = await prisma.driverCancellation.findFirstOrThrow({ where: { rideId: carId } });
    expect(record).toMatchObject({ riderId: mia.id, reason: "CANT_REACH_PICKUP" });
    const fresh = await rideOf(record.rebookedRideId!);
    expect(fresh).toMatchObject({ riderId: mia.id, status: "REQUESTED", type: "SHARED", driverId: null, pickupZoneId: miaSeat.pickupZoneId, dropoffZoneId: miaSeat.dropoffZoneId });
    expect(fresh.passengers).toEqual([expect.objectContaining({ riderId: mia.id, status: "WAITING", lockedFare: miaSeat.lockedFare })]);
    expect(await prisma.rideRejection.findMany({ where: { rideId: fresh.id } })).toEqual([expect.objectContaining({ driverUserId: d.id })]);

    // Her app: the banner finds the new search; the old car's detail points to it.
    expect((await mia.as("GET", "/rides/active")).json().ride).toMatchObject({ id: fresh.id, status: "REQUESTED" });
    const detail = (await mia.as("GET", `/rides/${carId}`)).json();
    expect(detail).toMatchObject({ seatCancelledBy: "driver", rebookedRideId: fresh.id });
    await vi.waitFor(() =>
      expect(sent).toContainEqual(
        expect.objectContaining({ to: "rider", id: mia.id, payload: expect.objectContaining({ status: "CANCELLED", rebookedRideId: fresh.id }) }),
      ),
    );
  });

  it("\"Rider didn't show\" is unchanged: booking ends, no driver cancellation", async () => {
    const { ama, rideId, d, seatId } = await loneRide();
    await d.as("POST", `/rides/${rideId}/passengers/${seatId}/arrived`);
    await prisma.ridePassenger.update({ where: { id: seatId }, data: { arrivedAt: new Date(Date.now() - 6 * 60_000), noShowOpensAt: new Date(Date.now() - 60_000) } });
    expect((await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "NO_SHOW" })).statusCode).toBe(200);
    expect(await seatStatus(seatId)).toBe("CANCELLED");
    expect((await rideOf(rideId)).status).toBe("CANCELLED");
    expect(await prisma.driverCancellation.count({ where: { rideId } })).toBe(0);
    expect((await ama.as("GET", "/rides/active")).json().ride).toBeNull();
  });

  it("counts on the driver's admin page and the Cancellations page", async () => {
    const { rideId, d, seatId } = await loneRide();
    await d.as("POST", `/rides/${rideId}/passengers/${seatId}/cancel`, { reason: "SAFETY_CONCERN" });
    const period = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;
    const driverRow = await prisma.driver.findUniqueOrThrow({ where: { userId: d.id } });

    const page = (await asAdmin("GET", `/admin/drivers/${driverRow.id}?${period}`)).json();
    expect(page.period.cancelledByDriver).toBe(1);
    expect(page.cancellations).toEqual([expect.objectContaining({ rideId, reason: "SAFETY_CONCERN", reasonLabel: "Safety concern" })]);

    const cancels = (await asAdmin("GET", `/admin/cancellations?${period}`)).json();
    expect(cancels.driverCancels.count).toBeGreaterThanOrEqual(1);
    expect(cancels.driverCancels.rows).toContainEqual(expect.objectContaining({ rideId, reason: "SAFETY_CONCERN" }));

    const detail = (await asAdmin("GET", `/admin/rides/${rideId}`)).json();
    expect(detail.timeline.some((t: { kind: string }) => t.kind === "driver_cancel")).toBe(true);
  });
});

// ─── 3. Admin cancels ───────────────────────────────────────────────────────

describe("admin cancels", () => {
  it("one seat: the car carries on, the rider is told, the audit log has who and why", async () => {
    const { owen, mia, carId, seatOf } = await sharedCar();
    const res = await asAdmin("POST", `/admin/rides/${carId}/seats/${seatOf(mia)}/cancel`, { reason: "Rider phoned support" });
    expect(res.statusCode).toBe(200);
    expect(await seatStatus(seatOf(mia))).toBe("CANCELLED");
    expect(await seatStatus(seatOf(owen))).toBe("WAITING");
    expect((await rideOf(carId)).status).toBe("MATCHED");
    expect(await prisma.adminAuditLog.findMany({ where: { actor: admin.id } })).toEqual([
      expect.objectContaining({ action: "ride.seat.cancel", target: carId, reason: `Seat ${seatOf(mia)}: Rider phoned support` }),
    ]);
    await vi.waitFor(() =>
      expect(sent).toContainEqual(expect.objectContaining({ to: "rider", id: mia.id, payload: expect.objectContaining({ cancelledBy: "admin" }) })),
    );
    expect((await mia.as("GET", `/rides/${carId}`)).json()).toMatchObject({ seatCancelledBy: "admin", rebookedRideId: null });
    // A repeat is harmless and writes no second row.
    expect((await asAdmin("POST", `/admin/rides/${carId}/seats/${seatOf(mia)}/cancel`, { reason: "again" })).statusCode).toBe(200);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id } })).toBe(1);
  });

  it("the whole ride, mid-trip: every seat goes and the driver is free", async () => {
    const { owen, carId, d, seatOf } = await sharedCar();
    await d.as("POST", `/rides/${carId}/passengers/${seatOf(owen)}/arrived`);
    await d.as("POST", `/rides/${carId}/passengers/${seatOf(owen)}/pickup`);
    const res = await asAdmin("POST", `/admin/rides/${carId}/cancel`, { reason: "Driver's phone died; trip stuck" });
    expect(res.statusCode).toBe(200);
    const car = await rideOf(carId);
    expect(car).toMatchObject({ status: "CANCELLED", cancelReason: "ADMIN_CANCELLED" });
    expect(car.passengers.every((p) => p.status === "CANCELLED")).toBe(true);
    expect((await d.as("GET", "/driver/rides/active")).json().ride ?? null).toBeNull();
    expect(await prisma.adminAuditLog.findFirst({ where: { actor: admin.id, action: "ride.cancel" } })).toMatchObject({ target: carId });
    // Already ended: refused, nothing more written.
    expect((await asAdmin("POST", `/admin/rides/${carId}/cancel`, { reason: "again" })).statusCode).toBe(409);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id } })).toBe(1);
  });

  it("a stuck merged seat (\"Waiting\", no driver) also cancels the rider's seat in the car it joined", async () => {
    const { mia, carId, miaRequest, seatOf } = await sharedCar();
    const leftover = (await rideOf(miaRequest)).passengers[0]!;
    expect(leftover.status).toBe("WAITING");
    const detail = (await asAdmin("GET", `/admin/rides/${miaRequest}`)).json();
    expect(detail.seats[0]).toMatchObject({ movedToCar: true, cancellable: true });

    const res = await asAdmin("POST", `/admin/rides/${miaRequest}/seats/${leftover.id}/cancel`, { reason: "Stuck after merge" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ alsoCancelledOnRideId: carId });
    expect(await seatStatus(leftover.id)).toBe("CANCELLED");
    expect(await seatStatus(seatOf(mia))).toBe("CANCELLED");
    expect((await rideOf(carId)).status).toBe("MATCHED");
  });

  it("needs a reason and an admin", async () => {
    const { owen, carId, seatOf } = await sharedCar();
    expect((await asAdmin("POST", `/admin/rides/${carId}/cancel`, { reason: "  " })).statusCode).toBe(400);
    expect((await asAdmin("POST", `/admin/rides/${carId}/cancel`, {})).statusCode).toBe(400);
    expect((await owen.as("POST", `/admin/rides/${carId}/cancel`, { reason: "x" })).statusCode).toBe(403);
    expect((await owen.as("POST", `/admin/rides/${carId}/seats/${seatOf(owen)}/cancel`, { reason: "x" })).statusCode).toBe(403);
    expect((await rideOf(carId)).status).toBe("MATCHED");
  });

  it("the ride list says which rides are open, and filters to them", async () => {
    const { carId, miaRequest } = await sharedCar();
    const list = (await asAdmin("GET", "/admin/rides?status=OPEN&pageSize=200")).json();
    const ids = list.rides.map((r: { id: string }) => r.id);
    expect(ids).toContain(carId);
    expect(ids).not.toContain(miaRequest);
    expect(list.rides.find((r: { id: string }) => r.id === carId).open).toBe(true);
  });
});
