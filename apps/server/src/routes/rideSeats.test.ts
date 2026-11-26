/**
 * Seats on bookings (2026-11-26). Riders booked one Shared seat and turned up
 * as two or three people. Pins:
 *   1. one booking, one fare, N seats: Shared 1/2/3 seats GH₵7/14/18 (max 3),
 *      Ride alone GH₵15 for 1–4 people; the shown price must be today's for
 *      those seats (FARE_CHANGED otherwise, nothing booked);
 *   2. older apps send no seat count: 1 seat at the old prices;
 *   3. a car holds 4 SEATS: a 2-seat booking takes 2 — in the lists, the
 *      board (with "Needs 2 seats, you have 1"), the add-preview, adding to a
 *      car (also a moving one), and a freed seat;
 *   4. switching Shared ↔ Ride alone keeps the seats (Ride alone for 4 can't
 *      become Shared);
 *   5. a booking a driver had to cancel searches again with all its seats.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { requestsThatFitCar } from "../services/ride/requestFit";
import { clearFarePricingCache } from "../services/ride/farePricing";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const userIds: string[] = [];
const driverIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  await app.ready();
  await prisma.farePricingSetting.deleteMany({});
  clearFarePricingCache();
});

afterEach(async () => {
  const rides = await prisma.ride.findMany({
    where: { OR: [{ riderId: { in: userIds } }, { passengers: { some: { riderId: { in: userIds } } } }] },
    select: { id: true },
  });
  const rideIds = rides.map((r) => r.id);
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await app.close();
});

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "RIDER" });
  const as = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { id: user.id, as };
}

/** A booking as the app makes it (zone ends: normal prices), `shown` the price it showed. */
async function book(type: "SHARED" | "LONE", seats?: number, shown?: number) {
  const r = await rider();
  const { pickup, dropoff } = await getTestZones();
  const res = await r.as("POST", "/rides", {
    pickupZoneId: pickup.id,
    dropoffZoneId: dropoff.id,
    type,
    paymentMethod: "CASH",
    ...(seats !== undefined ? { seats } : {}),
    ...(shown !== undefined ? { shownFarePesewas: shown } : {}),
  });
  return { r, res, rideId: res.statusCode === 201 ? (res.json().ride.id as string) : null };
}

async function booked(type: "SHARED" | "LONE", seats: number, shown: number) {
  const b = await book(type, seats, shown);
  expect(b.res.statusCode).toBe(201);
  return { ...b, rideId: b.rideId! };
}

async function driver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "DRIVER" });
  const as = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { id: user.id, as };
}

const rideWithSeats = (id: string) => prisma.ride.findUniqueOrThrow({ where: { id }, include: { passengers: true } });

describe("one booking, one fare, N seats", () => {
  it("Shared: 1 seat GH₵7, 2 seats GH₵14, 3 seats GH₵18 — kept on the request and the booking", async () => {
    for (const [seats, fare] of [[1, 700], [2, 1400], [3, 1800]] as const) {
      const { rideId } = await booked("SHARED", seats, fare);
      const ride = await rideWithSeats(rideId);
      expect(ride.occupancy).toBe(seats);
      expect(ride.passengers).toHaveLength(1);
      expect(ride.passengers[0]).toMatchObject({ seats, lockedFare: fare });
    }
  });

  it("Ride alone: GH₵15 for 1 to 4 people", async () => {
    for (const people of [1, 2, 3, 4]) {
      const { rideId } = await booked("LONE", people, 1500);
      expect((await rideWithSeats(rideId)).passengers[0]).toMatchObject({ seats: people, lockedFare: 1500 });
    }
  });

  it("at most 3 seats Shared and 4 people Ride alone; nothing is booked", async () => {
    const tooMany = await book("SHARED", 4, 2400);
    expect(tooMany.res.statusCode).toBe(400);
    expect(tooMany.res.json()).toMatchObject({ code: "INVALID_SEATS" });
    expect((await book("LONE", 5, 1500)).res.statusCode).toBe(400);
    expect((await book("SHARED", 0, 700)).res.statusCode).toBe(400);
    expect(await prisma.ride.count({ where: { riderId: { in: userIds } } })).toBe(0);
  });

  it("the shown price must be today's for those seats: FARE_CHANGED with the right one, nothing booked", async () => {
    const { res, r } = await book("SHARED", 2, 700);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "FARE_CHANGED", farePesewas: 1400 });
    expect(await prisma.ride.count({ where: { riderId: r.id } })).toBe(0);
  });

  it("an older app (no seats, no price): 1 seat at the old price", async () => {
    const { res, rideId } = await book("SHARED");
    expect(res.statusCode).toBe(201);
    const ride = await rideWithSeats(rideId!);
    expect(ride.occupancy).toBe(1);
    expect(ride.passengers[0]).toMatchObject({ seats: 1, lockedFare: 700 });
    const lone = await book("LONE");
    expect((await rideWithSeats(lone.rideId!)).passengers[0]).toMatchObject({ seats: 1, lockedFare: 1500 });
  });

  it("the rider sees their seats on their ride", async () => {
    const { r, rideId } = await booked("SHARED", 2, 1400);
    const res = await r.as("GET", `/rides/${rideId}`);
    expect(res.json().ride.passengers[0]).toMatchObject({ seats: 2, lockedFare: 1400 });
  });
});

describe("a car holds 4 seats, not 4 bookings", () => {
  /** A driver's car: they took a booking of `seats` seats. */
  async function carWith(seats: number) {
    const d = await driver();
    const first = await booked("SHARED", seats, [0, 700, 1400, 1800][seats]!);
    expect((await d.as("POST", `/rides/${first.rideId}/claim`)).statusCode).toBe(200);
    return { d, carId: first.rideId };
  }

  it("a 2-seat booking takes 2: a car with 2 taken fits a 2-seat booking, then nothing more", async () => {
    const { d, carId } = await carWith(2);
    const pair = await booked("SHARED", 2, 1400);
    const single = await booked("SHARED", 1, 700);
    const trio = await booked("SHARED", 3, 1800);

    const car = (await prisma.ride.findUniqueOrThrow({ where: { id: carId }, include: { passengers: true } }));
    const driverRow = { userId: d.id, isOnline: true, lastLat: null, lastLng: null };
    const fits = (await requestsThatFitCar(prisma, car, driverRow)).map((r) => r.id);
    expect(fits).toContain(pair.rideId);
    expect(fits).toContain(single.rideId);
    expect(fits).not.toContain(trio.rideId);

    // The board says why, in seats.
    const board = await d.as("GET", "/driver/requests/board");
    expect(board.statusCode).toBe(200);
    const trioCard = board.json().rides.find((x: { rideId: string }) => x.rideId === trio.rideId);
    expect(trioCard).toMatchObject({ seats: 3, boardCanTake: false, boardNote: "Needs 3 seats, you have 2" });
    expect(board.json().car).toMatchObject({ freeSeats: 2 });

    // The add-preview refuses it the same way.
    const preview = await d.as("GET", `/rides/${carId}/add-preview?requestRideId=${trio.rideId}`);
    expect(preview.statusCode).toBe(409);
    expect(preview.json()).toMatchObject({ code: "CAR_FULL", error: "Needs 3 seats, you have 2." });

    // Adding it anyway is refused and the request keeps searching.
    const refused = await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: trio.rideId });
    expect(refused.statusCode).toBe(409);
    expect((await prisma.ride.findUniqueOrThrow({ where: { id: trio.rideId } })).status).toBe("REQUESTED");

    // The 2-seat booking fills the car: 4 seats in 2 bookings.
    expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: pair.rideId })).statusCode).toBe(200);
    const full = await rideWithSeats(carId);
    expect(full.occupancy).toBe(4);
    expect(full.passengers.map((p) => p.seats).sort()).toEqual([2, 2]);
    expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: single.rideId })).statusCode).toBe(409);
  });

  it("a car with 3 seats taken takes only a 1-seat booking — also once it is moving", async () => {
    const { d, carId } = await carWith(3);
    const pair = await booked("SHARED", 2, 1400);
    const single = await booked("SHARED", 1, 700);
    // Moving: the first booking is picked up.
    const [seat] = (await rideWithSeats(carId)).passengers;
    expect((await d.as("POST", `/rides/${carId}/passengers/${seat!.id}/arrived`)).statusCode).toBe(200);
    expect((await d.as("POST", `/rides/${carId}/passengers/${seat!.id}/pickup`)).statusCode).toBe(200);
    expect((await rideWithSeats(carId)).status).toBe("IN_PROGRESS");

    expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: pair.rideId })).statusCode).toBe(409);
    expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: single.rideId })).statusCode).toBe(200);
    expect((await rideWithSeats(carId)).occupancy).toBe(4);
  });

  it("each booking pays its own fare (per booking, not per seat)", async () => {
    const { d, carId } = await carWith(2);
    const single = await booked("SHARED", 1, 700);
    expect((await d.as("POST", `/rides/${carId}/add-passenger`, { requestRideId: single.rideId })).statusCode).toBe(200);
    const fares = (await rideWithSeats(carId)).passengers.map((p) => [p.seats, p.lockedFare]);
    expect(fares).toEqual(expect.arrayContaining([[2, 1400], [1, 700]]));
  });

  it("the driver's offers and lists say the seats", async () => {
    const d = await driver();
    const pair = await booked("SHARED", 2, 1400);
    const party = await booked("LONE", 3, 1500);
    const list = await d.as("GET", "/driver/rides/eligible");
    const rows = list.json().rides as Array<{ rideId: string; seats: number; farePesewas: number }>;
    // Each listed request carries its seats (zone requests may not be offered to this driver: check what is).
    for (const row of rows) {
      if (row.rideId === pair.rideId) expect(row).toMatchObject({ seats: 2, farePesewas: 1400 });
      if (row.rideId === party.rideId) expect(row).toMatchObject({ seats: 3, farePesewas: 1500 });
    }
    const board = (await d.as("GET", "/driver/requests/board")).json().rides as Array<{ rideId: string; seats: number }>;
    expect(board.find((x) => x.rideId === pair.rideId)).toMatchObject({ seats: 2 });
    expect(board.find((x) => x.rideId === party.rideId)).toMatchObject({ seats: 3 });
  });

  it("the trip's riders carry their seats", async () => {
    const { d, carId } = await carWith(2);
    const trip = await d.as("GET", "/driver/rides/active");
    expect(trip.statusCode).toBe(200);
    expect(trip.json().ride.id).toBe(carId);
    expect(trip.json().ride.passengers[0]).toMatchObject({ seats: 2 });
  });
});

describe("switching Shared ↔ Ride alone keeps the seats", () => {
  it("Shared for 2 → Ride alone GH₵15 for 2 people", async () => {
    const { r, rideId } = await booked("SHARED", 2, 1400);
    const res = await r.as("POST", `/rides/${rideId}/switch`, { type: "LONE", shownFarePesewas: 1500 });
    expect(res.statusCode).toBe(200);
    expect(res.json().farePesewas).toBe(1500);
    expect((await rideWithSeats(rideId)).passengers[0]).toMatchObject({ seats: 2, lockedFare: 1500 });
  });

  it("Ride alone for 3 → Shared GH₵18; for 4 → refused, nothing changes", async () => {
    const three = await booked("LONE", 3, 1500);
    const ok = await three.r.as("POST", `/rides/${three.rideId}/switch`, { type: "SHARED", shownFarePesewas: 1800 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().farePesewas).toBe(1800);

    const four = await booked("LONE", 4, 1500);
    const refused = await four.r.as("POST", `/rides/${four.rideId}/switch`, { type: "SHARED", shownFarePesewas: 2400 });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: "TOO_MANY_FOR_SHARED" });
    expect((await rideWithSeats(four.rideId)).type).toBe("LONE");
  });

  it("a stale price on a switch is refused with the right one", async () => {
    const { r, rideId } = await booked("LONE", 2, 1500);
    const res = await r.as("POST", `/rides/${rideId}/switch`, { type: "SHARED", shownFarePesewas: 700 });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: "FARE_CHANGED", farePesewas: 1400 });
  });
});

describe("a freed seat", () => {
  it("a 2-seat booking the driver had to cancel searches again with its 2 seats and fare", async () => {
    const d = await driver();
    const first = await booked("SHARED", 1, 700);
    const pair = await booked("SHARED", 2, 1400);
    expect((await d.as("POST", `/rides/${first.rideId}/claim`)).statusCode).toBe(200);
    expect((await d.as("POST", `/rides/${first.rideId}/add-passenger`, { requestRideId: pair.rideId })).statusCode).toBe(200);
    const seat = (await rideWithSeats(first.rideId)).passengers.find((p) => p.riderId === pair.r.id)!;
    const res = await d.as("POST", `/rides/${first.rideId}/passengers/${seat.id}/cancel`, { reason: "CAR_PROBLEM" });
    expect(res.statusCode).toBe(200);

    expect((await rideWithSeats(first.rideId)).occupancy).toBe(1);
    const rebooked = await prisma.ride.findFirstOrThrow({
      where: { riderId: pair.r.id, status: "REQUESTED", id: { not: pair.rideId } },
      include: { passengers: true },
    });
    expect(rebooked.occupancy).toBe(2);
    expect(rebooked.passengers[0]).toMatchObject({ seats: 2, lockedFare: 1400 });
  });
});
