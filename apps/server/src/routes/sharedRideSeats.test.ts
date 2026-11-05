/**
 * Two riders sharing one driver: each rider follows only their own seat.
 *
 * Found on a phone test (2026-11-05), Bill and Ali both booking Shared and
 * the same driver taking both:
 *
 * - Bill's app said "Ride cancelled" while his ride was going on. Adding him
 *   to the car closes his own request (CANCELLED / MERGED_INTO_ANOTHER_RIDE),
 *   and the event that told his app said only "CANCELLED" — not where his
 *   car was — so the app showed the cancelled screen and stopped polling.
 * - Dropping one rider off didn't end their ride: it stayed "active" (no
 *   fare summary, no rating, the banner, no new booking) until the last
 *   rider in the car was dropped off.
 *
 * Each test runs both ways round: the rider acted on first is the car's
 * requester, or the rider who was added to it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { registerRatingRoutes } from "./ratings";
import { signAccessToken } from "../services/auth/tokens";
import { findActiveRideForRider } from "../services/ride/activeRide";
import { cleanupDriver, createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import * as rideSocket from "../realtime/rideSocket";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const userIds: string[] = [];
const driverIds: string[] = [];

/** Every event the server sent while a test ran: to a ride's room, or to one rider. */
type Sent = { to: "ride" | "rider"; id: string; event: string; payload: Record<string, unknown> };
let sent: Sent[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerRatingRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  sent = [];
  const rides = await prisma.ride.findMany({
    where: { OR: [{ riderId: { in: userIds } }, { passengers: { some: { riderId: { in: userIds } } } }] },
    select: { id: true },
  });
  const rideIds = rides.map((r) => r.id);
  await prisma.rating.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await app.close();
});

async function rider(name: string) {
  const user = await createTestUser("RIDER");
  await prisma.user.update({ where: { id: user.id }, data: { name } });
  userIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "RIDER" });
  const as = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { id: user.id, token, as };
}

async function requestShared(r: Awaited<ReturnType<typeof rider>>) {
  const { pickup, dropoff } = await getTestZones();
  const res = await r.as("POST", "/rides", { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "SHARED", paymentMethod: "CASH" });
  expect(res.statusCode).toBe(201);
  return res.json().ride.id as string;
}

/**
 * Bill and Ali each book Shared; the driver accepts `owner`'s request and
 * adds the other rider's into the same car, as the driver app does.
 */
async function sharedCar(owner: "bill" | "ali") {
  const bill = await rider("Bill Test");
  const ali = await rider("Ali Test");
  const billRequest = await requestShared(bill);
  const aliRequest = await requestShared(ali);

  const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(driver.id);
  const driverToken = signAccessToken({ userId: driver.id, role: "DRIVER" });
  const asDriver = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${driverToken}` }, ...(payload ? { payload } : {}) });

  const carId = owner === "bill" ? billRequest : aliRequest;
  const addedRequest = owner === "bill" ? aliRequest : billRequest;
  expect((await asDriver(`/rides/${carId}/claim`)).statusCode).toBe(200);

  sent = [];
  vi.spyOn(rideSocket, "emitRideEvent").mockImplementation((id, event, payload) => {
    sent.push({ to: "ride", id, event, payload: payload as unknown as Record<string, unknown> });
  });
  vi.spyOn(rideSocket, "emitToRider").mockImplementation((id, event, payload) => {
    sent.push({ to: "rider", id, event, payload: payload as unknown as Record<string, unknown> });
  });

  expect((await asDriver(`/rides/${carId}/add-passenger`, { requestRideId: addedRequest })).statusCode).toBe(200);

  const seats = await prisma.ridePassenger.findMany({ where: { rideId: carId } });
  const seatOf = (riderId: string) => seats.find((s) => s.riderId === riderId)!.id;
  const act = async (who: { id: string }, action: "arrived" | "pickup" | "dropoff" | "cancel") => {
    const res = await asDriver(`/rides/${carId}/passengers/${seatOf(who.id)}/${action}`);
    expect(res.statusCode).toBe(200);
    // The riders are told after the reply.
    await vi.waitFor(() => expect(sent.some((s) => s.event === "ride:passenger_status" && s.id === who.id)).toBe(true));
    return res;
  };
  return { bill, ali, billRequest, aliRequest, carId, addedRequest, driverToken, act };
}

/** What the rider's trip screen loads for a ride (GET /rides/:id). */
async function riderView(r: Awaited<ReturnType<typeof rider>>, rideId: string) {
  const res = await r.as("GET", `/rides/${rideId}`);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { ...body, mySeat: body.ride.passengers.find((p: { riderId: string }) => p.riderId === r.id) };
}

describe("the rider added to a car is told where it is, not just 'cancelled'", () => {
  it("the event closing their own request carries the merge and the car", async () => {
    const { billRequest, carId } = await sharedCar("ali");
    const toBillsRequest = sent.filter((s) => s.to === "ride" && s.id === billRequest && s.event === "ride:status");
    expect(toBillsRequest).toEqual([
      {
        to: "ride",
        id: billRequest,
        event: "ride:status",
        payload: { rideId: billRequest, status: "CANCELLED", cancelReason: "MERGED_INTO_ANOTHER_RIDE", mergedIntoRideId: carId },
      },
    ]);
  });
});

describe.each(["bill", "ali"] as const)("car booked by %s", (owner) => {
  it("picking Ali up sends Bill nothing and leaves Bill's seat as it was", async () => {
    const { bill, ali, carId, act } = await sharedCar(owner);
    await act(bill, "arrived");
    sent = [];
    await act(ali, "arrived");
    await act(ali, "pickup");

    // Nothing to Bill's own room; the car's room hears only that it moved off.
    expect(sent.filter((s) => s.to === "rider" && s.id === bill.id)).toEqual([]);
    expect(sent.filter((s) => s.to === "ride").map((s) => s.payload)).toEqual([{ rideId: carId, status: "IN_PROGRESS" }]);
    expect(sent.filter((s) => s.to === "rider").every((s) => s.id === ali.id)).toBe(true);

    const view = await riderView(bill, carId);
    expect(view.ride.status).toBe("IN_PROGRESS");
    expect(view.mySeat.status).toBe("ARRIVED");
    expect(view.fareSummary).toBeUndefined();
    expect((await findActiveRideForRider(prisma, bill.id))?.ride.id).toBe(carId);
  });

  it("dropping Bill off completes Bill's ride only; Ali rides on; the trip ends after Ali", async () => {
    const { bill, ali, carId, act } = await sharedCar(owner);
    for (const r of [ali, bill]) {
      await act(r, "arrived");
      await act(r, "pickup");
    }
    sent = [];
    await act(bill, "dropoff");

    // Bill: done, with his own fare summary, right away.
    const done = sent.find((s) => s.to === "rider" && s.id === bill.id && s.event === "ride:completed");
    expect(done?.payload).toMatchObject({ rideId: carId, fareSummary: { yourFarePesewas: 700, paymentMethod: "CASH" } });
    const billView = await riderView(bill, carId);
    expect(billView.mySeat.status).toBe("DROPPED_OFF");
    expect(billView.fareSummary).toMatchObject({ yourFarePesewas: 700, paymentMethod: "CASH" });
    expect(await findActiveRideForRider(prisma, bill.id)).toBeNull();
    expect((await bill.as("GET", "/rides/active")).json()).toEqual({ ride: null });
    expect((await bill.as("POST", "/ratings", { rideId: carId, stars: 5 })).statusCode).toBe(201);

    // Ali: still riding, told nothing, no fare summary yet.
    expect(sent.filter((s) => s.id === ali.id)).toEqual([]);
    expect(sent.filter((s) => s.to === "ride")).toEqual([]);
    const aliView = await riderView(ali, carId);
    expect(aliView.ride.status).toBe("IN_PROGRESS");
    expect(aliView.mySeat.status).toBe("PICKED_UP");
    expect(aliView.fareSummary).toBeUndefined();
    expect((await findActiveRideForRider(prisma, ali.id))?.ride.id).toBe(carId);
    expect((await ali.as("POST", "/ratings", { rideId: carId, stars: 5 })).statusCode).toBe(409);
    expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(0);

    // Bill books again while Ali is still in the car.
    const again = await requestShared(bill);
    expect((await findActiveRideForRider(prisma, bill.id))?.ride.id).toBe(again);
    await bill.as("POST", `/rides/${again}/cancel`, {});

    // The last drop-off ends the trip; the cash ledger counts each rider once.
    sent = [];
    await act(ali, "dropoff");
    const after = await prisma.ride.findUniqueOrThrow({ where: { id: carId } });
    expect(after.status).toBe("COMPLETED");
    expect(sent.filter((s) => s.to === "ride").map((s) => s.payload)).toEqual([{ rideId: carId, status: "COMPLETED" }]);
    await vi.waitFor(async () => {
      const ledger = await prisma.commissionLedger.findMany({ where: { rideId: carId } });
      // 15% of 2 × GH₵7.
      expect(ledger.map((l) => l.amountPesewas)).toEqual([210]);
    });
    expect((await riderView(ali, carId)).fareSummary).toMatchObject({ yourFarePesewas: 700, totalFarePesewas: 1400 });
    expect(await findActiveRideForRider(prisma, ali.id)).toBeNull();
  });

  it("a real cancel of Bill's seat still reads as cancelled; Ali carries on", async () => {
    const { bill, ali, carId, act } = await sharedCar(owner);
    await act(ali, "arrived");
    await act(ali, "pickup");
    sent = [];
    await act(bill, "cancel");

    expect(sent.find((s) => s.id === bill.id)?.payload).toMatchObject({ status: "CANCELLED" });
    expect(sent.filter((s) => s.id === ali.id)).toEqual([]);
    const billView = await riderView(bill, carId);
    expect(billView.mySeat.status).toBe("CANCELLED");
    expect(billView.fareSummary).toBeUndefined();
    expect(await findActiveRideForRider(prisma, bill.id)).toBeNull();
    expect((await riderView(ali, carId)).ride.status).toBe("IN_PROGRESS");
  });
});

describe("a whole ride really cancelled", () => {
  it("is still CANCELLED to its rider (the screen says Ride cancelled)", async () => {
    const bill = await rider("Bill Test");
    const id = await requestShared(bill);
    expect((await bill.as("POST", `/rides/${id}/cancel`, {})).statusCode).toBe(200);
    const view = await riderView(bill, id);
    expect(view.ride).toMatchObject({ status: "CANCELLED", mergedIntoRideId: null });
    expect(view.ride.cancelReason).not.toBe("MERGED_INTO_ANOTHER_RIDE");
  });
});
