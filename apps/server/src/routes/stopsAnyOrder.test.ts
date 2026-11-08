/**
 * A Shared car's stops done in any order, and "Undo" just after a step.
 *
 * Ali booked the car; Bill and Kofi were added to it. The driver reaches
 * them in whatever order the road gives — Kofi first, then Bill, Ali last —
 * and drops them off in another order again. Each rider follows only their
 * own seat; the trip and the cash-owed entry close at the last drop-off,
 * whoever that is.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { UNDO_ACCEPTED_FOR_MS, getSharedFarePerRider, splitFare } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerDriverRoutes } from "./driver";
import { registerRideRoutes } from "./rides";
import { registerRatingRoutes } from "./ratings";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { recordDriverPosition, resetLivePositionsForTests } from "../services/zones/livePositions";
import { resetRiderEtasForTests } from "../services/ride/riderEta";
import * as rideSocket from "../realtime/rideSocket";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
const userIds: string[] = [];
const driverIds: string[] = [];

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
  resetLivePositionsForTests();
  resetRiderEtasForTests();
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

type Rider = Awaited<ReturnType<typeof rider>>;

async function rider(name: string) {
  const user = await createTestUser("RIDER");
  await prisma.user.update({ where: { id: user.id }, data: { name } });
  userIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "RIDER" });
  const as = (method: "GET" | "POST", url: string, payload?: Record<string, unknown>) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { id: user.id, as };
}

async function requestShared(r: Rider) {
  const { pickup, dropoff } = await getTestZones();
  const res = await r.as("POST", "/rides", { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "SHARED", paymentMethod: "CASH" });
  expect(res.statusCode).toBe(201);
  return res.json().ride.id as string;
}

async function driverAccount() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  driverIds.push(user.id);
  const token = signAccessToken({ userId: user.id, role: "DRIVER" });
  const post = (url: string, payload?: Record<string, unknown>) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  return { id: user.id, post };
}

type Action = "arrived" | "pickup" | "dropoff";

/** Ali's car, with Bill and Kofi added to it, as the driver app does. */
async function carOfThree() {
  const ali = await rider("Ali Test");
  const bill = await rider("Bill Test");
  const kofi = await rider("Kofi Test");
  const carId = await requestShared(ali);
  const billRequest = await requestShared(bill);
  const kofiRequest = await requestShared(kofi);

  const driver = await driverAccount();
  expect((await driver.post(`/rides/${carId}/claim`)).statusCode).toBe(200);
  expect((await driver.post(`/rides/${carId}/add-passenger`, { requestRideId: billRequest })).statusCode).toBe(200);
  expect((await driver.post(`/rides/${carId}/add-passenger`, { requestRideId: kofiRequest })).statusCode).toBe(200);

  sent = [];
  vi.spyOn(rideSocket, "emitRideEvent").mockImplementation((id, event, payload) => {
    sent.push({ to: "ride", id, event, payload: payload as unknown as Record<string, unknown> });
  });
  vi.spyOn(rideSocket, "emitToRider").mockImplementation((id, event, payload) => {
    sent.push({ to: "rider", id, event, payload: payload as unknown as Record<string, unknown> });
  });
  vi.spyOn(rideSocket, "removeRiderFromRide").mockImplementation(() => {});
  vi.spyOn(rideSocket, "addRiderToRide").mockImplementation(() => {});

  const seats = await prisma.ridePassenger.findMany({ where: { rideId: carId } });
  expect(seats).toHaveLength(3);
  const seatOf = (who: Rider) => seats.find((s) => s.riderId === who.id)!.id;
  const url = (who: Rider, action: Action | "undo") => `/rides/${carId}/passengers/${seatOf(who)}/${action}`;

  /** A step, then the rider's own news (sent after the reply). */
  const act = async (who: Rider, action: Action) => {
    const before = sent.filter((s) => s.event === "ride:passenger_status" && s.id === who.id).length;
    const res = await driver.post(url(who, action));
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.event === "ride:passenger_status" && s.id === who.id).length).toBeGreaterThan(before),
    );
    return res;
  };
  /** As the driver app does from the Stops list: the arrival, then the pickup. */
  const pickUp = async (who: Rider) => {
    await act(who, "arrived");
    await act(who, "pickup");
  };
  const undo = (who: Rider, step: "pickup" | "dropoff", extra: Record<string, unknown> = {}) =>
    driver.post(url(who, "undo"), { step, ...extra });

  return { ali, bill, kofi, carId, driver, seatOf, url, act, pickUp, undo };
}

const seat = (id: string) => prisma.ridePassenger.findUniqueOrThrow({ where: { id } });
const rideOf = (id: string) => prisma.ride.findUniqueOrThrow({ where: { id } });

async function riderView(r: Rider, rideId: string) {
  const res = await r.as("GET", `/rides/${rideId}`);
  expect(res.statusCode).toBe(200);
  const body = res.json();
  return { ...body, mySeat: body.ride.passengers.find((p: { riderId: string }) => p.riderId === r.id) };
}

describe("stops in any order, three riders", () => {
  it("Kofi, Bill, then Ali picked up; Bill, Kofi, then Ali dropped off — each follows their own seat; the last drop-off closes the trip and the ledger", async () => {
    const { ali, bill, kofi, carId, act, pickUp } = await carOfThree();

    // Kofi first, though Ali booked the car.
    await pickUp(kofi);
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");
    expect((await riderView(kofi, carId)).mySeat.status).toBe("PICKED_UP");
    expect((await riderView(ali, carId)).mySeat.status).toBe("WAITING");
    expect((await riderView(bill, carId)).mySeat.status).toBe("WAITING");

    await pickUp(bill);
    // Bill dropped off before Ali has even been picked up.
    await act(bill, "dropoff");
    const billView = await riderView(bill, carId);
    expect(billView.mySeat.status).toBe("DROPPED_OFF");
    expect(billView.fareSummary).toMatchObject({ yourFarePesewas: expect.any(Number) });
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");
    // Nothing owed yet: the trip isn't over.
    expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(0);

    await act(kofi, "dropoff");
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");
    expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(0);

    await pickUp(ali);
    sent = [];
    await act(ali, "dropoff");

    const ride = await rideOf(carId);
    expect(ride.status).toBe("COMPLETED");
    const seats = await prisma.ridePassenger.findMany({ where: { rideId: carId } });
    expect(seats.map((s) => s.status)).toEqual(["DROPPED_OFF", "DROPPED_OFF", "DROPPED_OFF"]);
    expect(seats.every((s) => s.fareCharged === s.lockedFare && s.droppedOffAt && s.pickedUpAt)).toBe(true);
    const total = seats.reduce((sum, s) => sum + s.fareCharged!, 0);
    expect(total).toBe(3 * getSharedFarePerRider(3));
    await vi.waitFor(async () => {
      const ledger = await prisma.commissionLedger.findMany({ where: { rideId: carId } });
      expect(ledger).toEqual([expect.objectContaining({ amountPesewas: splitFare(total).commission })]);
    });
    // Every rider hears the trip is complete.
    await vi.waitFor(() => {
      const completed = sent.filter((s) => s.event === "ride:completed").map((s) => s.id).sort();
      expect(completed).toEqual([ali.id, bill.id, kofi.id].sort());
    });
  });

  it("a drop-off before that rider's pickup is refused; other riders' pickups don't count", async () => {
    const { bill, kofi, driver, url, pickUp } = await carOfThree();
    await pickUp(kofi);
    const res = await driver.post(url(bill, "dropoff"));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "INVALID_PASSENGER_STATE", error: "This rider hasn't been picked up yet." });
  });

  it("another driver can't act on (or undo) a seat in this car", async () => {
    const { bill, carId, seatOf, pickUp } = await carOfThree();
    const other = await driverAccount();
    for (const action of ["arrived", "pickup", "dropoff"]) {
      const res = await other.post(`/rides/${carId}/passengers/${seatOf(bill)}/${action}`);
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("PASSENGER_NOT_FOUND");
    }
    await pickUp(bill);
    const res = await other.post(`/rides/${carId}/passengers/${seatOf(bill)}/undo`, { step: "pickup" });
    expect(res.statusCode).toBe(404);
    expect((await seat(seatOf(bill))).status).toBe("PICKED_UP");
  });

  it("a double tap or retry counts once", async () => {
    const { ali, bill, kofi, carId, driver, url, act, pickUp } = await carOfThree();
    await act(bill, "arrived");
    const first = await driver.post(url(bill, "pickup"));
    const again = await driver.post(url(bill, "pickup"));
    expect([first.statusCode, again.statusCode]).toEqual([200, 200]);
    const pickedUpAt = (await seat(again.json().passenger.id)).pickedUpAt;
    expect(pickedUpAt).not.toBeNull();

    await act(bill, "dropoff");
    const droppedAgain = await driver.post(url(bill, "dropoff"));
    expect(droppedAgain.statusCode).toBe(200);
    const billSeat = await seat(droppedAgain.json().passenger.id);
    expect(billSeat.pickedUpAt).toEqual(pickedUpAt);
    // Bill heard about each step once.
    await vi.waitFor(() =>
      expect(sent.filter((s) => s.event === "ride:passenger_status" && s.id === bill.id).map((s) => s.payload.status)).toEqual([
        "ARRIVED",
        "PICKED_UP",
        "DROPPED_OFF",
      ]),
    );

    await pickUp(kofi);
    await act(kofi, "dropoff");
    await pickUp(ali);
    await act(ali, "dropoff");
    await driver.post(url(ali, "dropoff"));
    await vi.waitFor(async () => expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(1));
    // One summary per rider at the end, even with the repeated last drop-off.
    expect(sent.filter((s) => s.event === "ride:completed" && s.id === ali.id)).toHaveLength(1);
  });

  it("each step sends the riders still in or waiting for the car a fresh ETA at once", async () => {
    const { ali, bill, carId, driver, pickUp } = await carOfThree();
    recordDriverPosition(driver.id, { latitude: 5.6515, longitude: -0.18969 }, Date.now(), carId);
    await pickUp(bill);
    await vi.waitFor(() => {
      const etas = sent.filter((s) => s.event === "ride:eta");
      expect(etas.find((e) => e.id === bill.id)?.payload).toMatchObject({ rideId: carId, toward: "dropoff" });
      expect(etas.find((e) => e.id === ali.id)?.payload).toMatchObject({ rideId: carId, toward: "pickup" });
    });
  });
});

describe("undo", () => {
  it("a pickup, within the window: the seat goes back, and so does the car if no one else is in it", async () => {
    const { bill, carId, seatOf, undo, pickUp } = await carOfThree();
    await pickUp(bill);
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");

    sent = [];
    const res = await undo(bill, "pickup");
    expect(res.statusCode).toBe(200);
    expect(res.json().passenger.status).toBe("ARRIVED");
    const billSeat = await seat(seatOf(bill));
    expect(billSeat).toMatchObject({ status: "ARRIVED", pickedUpAt: null });
    expect(billSeat.arrivedAt).not.toBeNull();
    const ride = await rideOf(carId);
    expect(ride).toMatchObject({ status: "ARRIVED", departedAt: null });
    await vi.waitFor(() => {
      expect(sent).toContainEqual(expect.objectContaining({ to: "rider", id: bill.id, event: "ride:passenger_status", payload: expect.objectContaining({ status: "ARRIVED" }) }));
      expect(sent).toContainEqual(expect.objectContaining({ to: "ride", id: carId, event: "ride:status", payload: { rideId: carId, status: "ARRIVED" } }));
    });

    // A repeat changes nothing.
    const again = await undo(bill, "pickup");
    expect(again.statusCode).toBe(200);
    expect((await seat(seatOf(bill))).status).toBe("ARRIVED");
  });

  it("a pickup marked straight from waiting goes back to waiting; the car back to its driver on the way", async () => {
    const { bill, carId, seatOf, undo, pickUp } = await carOfThree();
    await pickUp(bill);
    const res = await undo(bill, "pickup", { withArrival: true });
    expect(res.statusCode).toBe(200);
    expect(await seat(seatOf(bill))).toMatchObject({ status: "WAITING", arrivedAt: null, pickedUpAt: null });
    expect((await rideOf(carId)).status).toBe("MATCHED");
  });

  it("a pickup with others in the car leaves the car under way", async () => {
    const { bill, kofi, carId, undo, pickUp } = await carOfThree();
    await pickUp(kofi);
    await pickUp(bill);
    expect((await undo(bill, "pickup")).statusCode).toBe(200);
    const ride = await rideOf(carId);
    expect(ride.status).toBe("IN_PROGRESS");
    expect(ride.departedAt).not.toBeNull();
  });

  it("a drop-off (not the last), within the window: back in the car, the fare summary gone, the trip goes on", async () => {
    const { ali, bill, carId, seatOf, act, undo, pickUp } = await carOfThree();
    await pickUp(ali);
    await pickUp(bill);
    await act(bill, "dropoff");
    expect((await riderView(bill, carId)).fareSummary).toBeDefined();

    sent = [];
    const res = await undo(bill, "dropoff");
    expect(res.statusCode).toBe(200);
    expect(await seat(seatOf(bill))).toMatchObject({ status: "PICKED_UP", droppedOffAt: null, fareCharged: null });
    const view = await riderView(bill, carId);
    expect(view.mySeat.status).toBe("PICKED_UP");
    expect(view.fareSummary).toBeUndefined();
    await vi.waitFor(() => expect(rideSocket.addRiderToRide).toHaveBeenCalledWith(bill.id, carId));
    // Rating isn't open again until Bill is really dropped off.
    expect((await rideOf(carId)).status).toBe("IN_PROGRESS");
  });

  it("after the window: refused, nothing changes", async () => {
    const { bill, seatOf, undo, pickUp, act } = await carOfThree();
    await pickUp(bill);
    const late = new Date(Date.now() - UNDO_ACCEPTED_FOR_MS - 1_000);
    await prisma.ridePassenger.update({ where: { id: seatOf(bill) }, data: { pickedUpAt: late } });
    const res = await undo(bill, "pickup");
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "UNDO_EXPIRED", error: "Too late to undo this pickup." });
    expect((await seat(seatOf(bill))).status).toBe("PICKED_UP");

    await act(bill, "dropoff");
    await prisma.ridePassenger.update({ where: { id: seatOf(bill) }, data: { droppedOffAt: late } });
    expect((await undo(bill, "dropoff")).json().code).toBe("UNDO_EXPIRED");
  });

  it("not once something later happened to that seat: dropped off, rated, or booked again", async () => {
    const { ali, bill, kofi, seatOf, act, undo, pickUp } = await carOfThree();
    await pickUp(ali);
    await pickUp(bill);
    await act(bill, "dropoff");
    const pickupUndo = await undo(bill, "pickup");
    expect(pickupUndo.statusCode).toBe(409);
    expect(pickupUndo.json()).toMatchObject({ code: "UNDO_TOO_LATE", error: "This rider has already been dropped off." });

    // Bill books his next ride straight away.
    await requestShared(bill);
    const rebooked = await undo(bill, "dropoff");
    expect(rebooked.json()).toMatchObject({ code: "UNDO_TOO_LATE", error: "This rider has already booked another ride." });
    expect((await seat(seatOf(bill))).status).toBe("DROPPED_OFF");

    // Kofi rates the trip the moment he's out.
    await pickUp(kofi);
    await act(kofi, "dropoff");
    const ride = await prisma.ridePassenger.findUniqueOrThrow({ where: { id: seatOf(kofi) }, select: { rideId: true } });
    const rating = await kofi.as("POST", "/ratings", { rideId: ride.rideId, stars: 5 });
    expect(rating.statusCode).toBe(201);
    const rated = await undo(kofi, "dropoff");
    expect(rated.json()).toMatchObject({ code: "UNDO_TOO_LATE", error: "This rider has already rated the trip." });
  });

  it("never the trip's last drop-off (out of order): the trip, the summaries and the ledger stay closed", async () => {
    const { ali, bill, kofi, carId, seatOf, act, undo, pickUp } = await carOfThree();
    await pickUp(kofi);
    await pickUp(ali);
    await pickUp(bill);
    await act(ali, "dropoff");
    await act(bill, "dropoff");
    await act(kofi, "dropoff");
    await vi.waitFor(async () => expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(1));

    const res = await undo(kofi, "dropoff");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("TRIP_ENDED");
    // And a drop-off made before it can't be undone now either.
    expect((await undo(bill, "dropoff")).json().code).toBe("TRIP_ENDED");
    expect((await rideOf(carId)).status).toBe("COMPLETED");
    expect((await seat(seatOf(kofi))).status).toBe("DROPPED_OFF");
    expect(await prisma.commissionLedger.count({ where: { rideId: carId } })).toBe(1);
  });

  it("only takes a pickup or a drop-off", async () => {
    const { bill, undo } = await carOfThree();
    expect((await undo(bill, "arrived" as never)).statusCode).toBe(400);
  });
});
