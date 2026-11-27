/**
 * Scheduled rides over HTTP (routes/scheduled.ts): the rider's schedule
 * screen, booking at the price shown, the Home card and intro, cancelling;
 * the driver's Schedule tab and board; the admin day view and settings.
 * The rules themselves: services/scheduled/scheduled.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_SCHEDULE_SETTINGS, DEFAULT_WEEKLY_SCHEDULE, type ScheduleOptions } from "@rida/shared";
import { clearServiceHoursCache } from "../services/service/serviceHours";

vi.mock("../services/ride/dispatch", async (original) => ({
  ...(await original<typeof import("../services/ride/dispatch")>()),
  broadcastRide: vi.fn(async () => []),
  reofferToDriver: vi.fn(),
}));

import { prisma } from "../db/prisma";
import { registerScheduledRoutes } from "./scheduled";
import { registerDriverRoutes } from "./driver";
import { signAccessToken } from "../services/auth/tokens";
import { createTestDriver, createTestUser, getTestZones } from "../services/ride/testFixtures";
import { readScheduleSettingsRow, setScheduleSettingsForTests } from "../services/scheduled/settings";

let app: FastifyInstance;
const userIds: string[] = [];
let ends: { pickup: { latitude: number; longitude: number }; dropoff: { latitude: number; longitude: number } };

async function as(role: "RIDER" | "DRIVER" | "ADMIN") {
  if (role === "DRIVER") {
    const { user } = await createTestDriver({ isOnline: true, isApproved: true });
    userIds.push(user.id);
    return { id: user.id, auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "DRIVER" })}` } };
  }
  const created = await createTestUser("RIDER");
  const user = role === "ADMIN" ? await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } }) : created;
  userIds.push(user.id);
  return { id: user.id, auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: user.role })}` } };
}

/** Service hours as they were, put back after (today-only slots would otherwise depend on the time of day). */
let savedHours: Awaited<ReturnType<typeof prisma.serviceHoursSetting.findUnique>> = null;

beforeAll(async () => {
  savedHours = await prisma.serviceHoursSetting.findUnique({ where: { id: "service" } });
  const open = { overrideMode: "OPEN" as const, overrideUntil: null, blockWhenNoDrivers: false };
  await prisma.serviceHoursSetting.upsert({ where: { id: "service" }, create: { id: "service", weekly: DEFAULT_WEEKLY_SCHEDULE as unknown as object, ...open }, update: open });
  clearServiceHoursCache();
  setScheduleSettingsForTests();
  app = Fastify();
  registerScheduledRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  await app.ready();
  const { pickup, dropoff } = await getTestZones();
  ends = { pickup: { latitude: pickup.latitude, longitude: pickup.longitude }, dropoff: { latitude: dropoff.latitude, longitude: dropoff.longitude } };
});

afterAll(async () => {
  const cars = await prisma.scheduledBooking.findMany({ where: { riderId: { in: userIds } }, select: { carId: true } });
  await prisma.scheduledCar.deleteMany({ where: { id: { in: cars.map((c) => c.carId) } } });
  await prisma.scheduleStrike.deleteMany({ where: { riderId: { in: userIds } } });
  await prisma.scheduleSetting.deleteMany({});
  await prisma.adminAuditLog.deleteMany({ where: { actor: { in: userIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (savedHours) {
    const { id: _id, updatedAt: _u, ...rest } = savedHours;
    await prisma.serviceHoursSetting.update({ where: { id: "service" }, data: { ...rest, weekly: rest.weekly as object } });
  } else await prisma.serviceHoursSetting.deleteMany({ where: { id: "service" } });
  clearServiceHoursCache();
  await app.close();
});

/** The latest bookable slot the server offers (far from every cutoff). */
async function laterSlot(auth: Record<string, string>, seats = 1): Promise<{ options: ScheduleOptions; arriveBy: string }> {
  const res = await app.inject({ method: "POST", url: "/rides/scheduled/options", headers: auth, payload: { ...ends, seats } });
  expect(res.statusCode).toBe(200);
  const options = res.json() as ScheduleOptions;
  const slots = options.days.flatMap((d) => d.slots).filter((s) => s.bookable);
  expect(slots.length).toBeGreaterThan(0);
  return { options, arriveBy: slots[slots.length - 1]!.arriveBy };
}

describe("rider", () => {
  it("options → book at the shown price → card → cancel", async () => {
    const rider = await as("RIDER");
    const mineBefore = await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth });
    expect(mineBefore.json()).toMatchObject({ booking: null, enabled: true, intro: { show: true } });

    const { options, arriveBy } = await laterSlot(rider.auth, 2);
    expect(options.sharedBySeats).toHaveLength(3);

    const wrongPrice = await app.inject({
      method: "POST",
      url: "/rides/scheduled",
      headers: rider.auth,
      payload: { ...ends, arriveBy, seats: 2, shownFarePesewas: 1 },
    });
    expect(wrongPrice.statusCode).toBe(422);
    expect(wrongPrice.json().code).toBe("FARE_CHANGED");

    const booked = await app.inject({
      method: "POST",
      url: "/rides/scheduled",
      headers: rider.auth,
      payload: { ...ends, arriveBy, seats: 2, shownFarePesewas: options.sharedBySeats[1] },
    });
    expect(booked.statusCode).toBe(201);
    const booking = booked.json().booking;
    expect(booking).toMatchObject({ seats: 2, farePesewas: options.sharedBySeats[1], state: "WAITING_FOR_RIDERS", carSeatsTaken: 2, carSeats: 4 });

    const mine = await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth });
    expect(mine.json()).toMatchObject({ booking: { id: booking.id }, intro: { show: false } });

    const coming = await app.inject({ method: "POST", url: `/rides/scheduled/${booking.id}/coming`, headers: rider.auth, payload: {} });
    expect(coming.statusCode).toBe(200);

    const cancel = await app.inject({ method: "POST", url: `/rides/scheduled/${booking.id}/cancel`, headers: rider.auth, payload: {} });
    expect(cancel.json()).toMatchObject({ cancelled: true, strike: false });
    const after = await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth });
    expect(after.json().booking).toBeNull();
  });

  it("a driver can't book, and a slot off the grid is refused", async () => {
    const driver = await as("DRIVER");
    const res = await app.inject({ method: "POST", url: "/rides/scheduled/options", headers: driver.auth, payload: { ...ends } });
    expect(res.statusCode).toBe(403);
    const rider = await as("RIDER");
    const odd = await app.inject({
      method: "POST",
      url: "/rides/scheduled",
      headers: rider.auth,
      payload: { ...ends, arriveBy: new Date(Date.now() + 3 * 60 * 60_000 + 7 * 60_000).toISOString() },
    });
    expect(odd.statusCode).toBe(422);
  });
});

describe("driver", () => {
  it("a 3-seat booking shows at once in the Schedule tab and on the board with its label; accepting moves it to mine", async () => {
    const rider = await as("RIDER");
    const { arriveBy } = await laterSlot(rider.auth, 3);
    const booked = await app.inject({ method: "POST", url: "/rides/scheduled", headers: rider.auth, payload: { ...ends, arriveBy, seats: 3 } });
    expect(booked.statusCode).toBe(201);
    const carId = booked.json().booking.carId as string;

    const driver = await as("DRIVER");
    const tab = (await app.inject({ method: "GET", url: "/driver/scheduled", headers: driver.auth })).json();
    const offer = tab.open.find((c: { carId: string }) => c.carId === carId);
    expect(offer).toMatchObject({ seats: 3, canAccept: true, mine: false, riders: [] });
    expect(offer.label).toMatch(/^Scheduled · \d{1,2}:\d{2} (AM|PM) · 3 seats · GH₵18$/);

    const board = (await app.inject({ method: "GET", url: "/driver/requests/board", headers: driver.auth })).json();
    expect(board.scheduled.some((c: { carId: string }) => c.carId === carId)).toBe(true);

    const accepted = await app.inject({ method: "POST", url: `/driver/scheduled/${carId}/accept`, headers: driver.auth, payload: { source: "SCHEDULE" } });
    expect(accepted.statusCode).toBe(200);
    const mine = accepted.json().mine.find((c: { carId: string }) => c.carId === carId);
    expect(mine).toMatchObject({ mine: true, status: "ACCEPTED" });
    expect(mine.riders[0]).toMatchObject({ seats: 3 });
    expect(mine.leaveBy).not.toBeNull();

    const card = (await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth })).json().booking;
    expect(card.state).toBe("CAR_CONFIRMED");

    const back = await app.inject({ method: "POST", url: `/driver/scheduled/${carId}/cancel`, headers: driver.auth, payload: {} });
    expect(back.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth })).json().booking.state).toBe("WAITING_FOR_RIDERS");
  });
});

describe("admin", () => {
  it("settings: saved, audit-logged, refused when they contradict each other; the intro switch", async () => {
    const admin = await as("ADMIN");
    const get = await app.inject({ method: "GET", url: "/admin/schedule-settings", headers: admin.auth });
    expect(get.json().settings).toMatchObject({ enabled: true, introEnabled: true, slotMinutes: 10 });

    const { updatedAt: _u, updatedBy: _b, ...current } = get.json().settings;
    const bad = await app.inject({ method: "PUT", url: "/admin/schedule-settings", headers: admin.auth, payload: { ...current, offerLaterSeats: 3 } });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({ method: "PUT", url: "/admin/schedule-settings", headers: admin.auth, payload: { ...current, introEnabled: false, freeCancelMinutes: 45 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings).toMatchObject({ introEnabled: false, freeCancelMinutes: 45 });
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "schedule.settings" } })).toBe(1);

    const rider = await as("RIDER");
    expect((await app.inject({ method: "GET", url: "/rides/scheduled/mine", headers: rider.auth })).json().intro.show).toBe(false);

    await prisma.scheduleSetting.deleteMany({});
    await readScheduleSettingsRow(prisma);
    expect(DEFAULT_SCHEDULE_SETTINGS.introEnabled).toBe(true);
  });

  it("the day view counts and lists cars", async () => {
    const admin = await as("ADMIN");
    const res = await app.inject({ method: "GET", url: "/admin/scheduled", headers: admin.auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ totals: expect.objectContaining({ bookings: expect.any(Number), toLive: expect.any(Number) }) });
    expect(res.json().recent).toHaveLength(14);
    expect((await app.inject({ method: "GET", url: "/admin/scheduled?day=nope", headers: admin.auth })).statusCode).toBe(400);
  });
});
