import { randomBytes } from "node:crypto";
/**
 * Exact pickup and drop-off pins (2026-10), with zones kept behind the
 * scenes:
 *
 * - the server derives every ride's zones from its pins (never from the app);
 * - pins outside the service area are refused in words the app can show;
 * - an old app build sending zone ids alone gets exactly the old ride;
 * - pins reach only the rider, their assigned driver and admins — names only
 *   on the driver's request list, the broadcast and /track, the named place
 *   (not the pin) in the add-rider preview, and never another passenger;
 * - place search, the admin Places screen's API (audit-logged), and road
 *   routes between pins (OSRM, cached, with a fallback).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Place, Zone } from "@prisma/client";
import { PINNED_LOCATION_LABEL, decodePolyline, nearestZone } from "@rida/shared";
import { prisma } from "../db/prisma";
import { registerRideRoutes } from "./rides";
import { registerDriverRoutes } from "./driver";
import { registerSafetyRoutes } from "./safety";
import { registerPlaceRoutes } from "./places";
import { registerAdminRoutes } from "./admin";
import { signAccessToken } from "../services/auth/tokens";
import { cleanupDriver, createTestDriver, createTestUser } from "../services/ride/testFixtures";
import * as rideSocket from "../realtime/rideSocket";
import { broadcastRide } from "../services/ride/dispatch";
import { setRouteFetcherForTests } from "../services/routing/pointRoutes";

vi.mock("../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let app: FastifyInstance;
let zones: Zone[];
const placeIds: string[] = [];
const userIds: string[] = [];
const driverIds: string[] = [];
const MARK = `pins-test-${Date.now()}`;

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerSafetyRoutes(app, prisma);
  registerPlaceRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  await app.ready();
  zones = await prisma.zone.findMany();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setRouteFetcherForTests(null);
  const rides = await prisma.ride.findMany({
    where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: driverIds } }] },
    select: { id: true },
  });
  const rideIds = rides.map((r) => r.id);
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.updateMany({ where: { id: { in: rideIds } }, data: { mergedIntoRideId: null } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actor: { in: userIds } } });
  await prisma.place.deleteMany({ where: { id: { in: placeIds } } });
  placeIds.length = 0;
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
  while (driverIds.length) await cleanupDriver(driverIds.pop()!);
});

afterAll(async () => {
  await prisma.pointRoute.deleteMany({ where: { key: { contains: "5.6" } } });
  await app.close();
});

// Real campus spots (OpenStreetMap), all inside the service area.
const BALME = { latitude: 5.65201, longitude: -0.18705 };
const NIGHT_MARKET = { latitude: 5.64208, longitude: -0.1856 };
const VOLTA = { latitude: 5.6515, longitude: -0.18969 };
const UGMC = { latitude: 5.631864, longitude: -0.185925 }; // campus's far south
const ACCRA_MALL = { latitude: 5.62218, longitude: -0.17326 }; // off campus: outside the area
const KUMASI = { latitude: 6.6885, longitude: -1.6244 };

async function addPlace(name: string, at: { latitude: number; longitude: number }, aliases: string[] = []): Promise<Place> {
  const zone = nearestZone(at.latitude, at.longitude, zones)!;
  const place = await prisma.place.create({
    data: { name: `${name}`, aliases, ...at, category: "LANDMARK", zoneId: zone.id, source: `${MARK}:${name}` },
  });
  placeIds.push(place.id);
  return place;
}

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "RIDER" }) };
}

async function onlineDriver(zoneId: string) {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true, currentZoneId: zoneId });
  driverIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

async function admin() {
  const user = await createTestUser("RIDER");
  await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
  userIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "ADMIN" }) };
}

function book(token: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/rides", headers: { authorization: `Bearer ${token}` }, payload: body });
}

function get(url: string, token: string) {
  return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

/** Two points about `meters` apart in the same zone: a zone centre and a spot due south of the southernmost zone. */
function sameZonePair(meters: number) {
  const south = [...zones].sort((a, b) => a.latitude - b.latitude)[0]!;
  const here = { latitude: south.latitude - 0.0002, longitude: south.longitude };
  return [here, { latitude: here.latitude - meters / 111_000, longitude: here.longitude }] as const;
}

const COORD_KEYS = ["pickupLat", "pickupLng", "dropoffLat", "dropoffLng"];

/** True when any of the given numbers appears anywhere in the response text. */
function mentions(text: string, ...values: number[]): boolean {
  return values.some((v) => text.includes(String(v)));
}

describe("booking with exact pins", () => {
  it("stores the pins and labels, and derives the zones itself — ignoring any zone the app sends", async () => {
    const balme = await addPlace("Balme Library", BALME, ["Balme"]);
    const { token } = await rider();
    const wrongZone = zones.find((z) => z.id !== nearestZone(BALME.latitude, BALME.longitude, zones)!.id)!;

    const res = await book(token, {
      type: "LONE",
      pickup: { placeId: balme.id },
      dropoff: { latitude: NIGHT_MARKET.latitude, longitude: NIGHT_MARKET.longitude },
      pickupZoneId: wrongZone.id, // an app may not choose the zone
      pickupNote: "  At the fountain,  blue shirt ",
    });

    expect(res.statusCode).toBe(201);
    const { ride } = res.json();
    expect(ride.pickupZoneId).toBe(nearestZone(BALME.latitude, BALME.longitude, zones)!.id);
    expect(ride.dropoffZoneId).toBe(nearestZone(NIGHT_MARKET.latitude, NIGHT_MARKET.longitude, zones)!.id);
    expect(ride).toMatchObject({
      pickupLat: BALME.latitude,
      pickupLng: BALME.longitude,
      pickupLabel: "Balme Library",
      pickupPlaceId: balme.id,
      dropoffLat: NIGHT_MARKET.latitude,
      dropoffLabel: PINNED_LOCATION_LABEL, // no place near it in this test
      pickupNote: "At the fountain, blue shirt",
    });
    // The rider's seat carries the same pins (that's what the driver navigates to).
    expect(ride.passengers[0]).toMatchObject({ pickupLat: BALME.latitude, pickupLabel: "Balme Library", pickupNote: "At the fountain, blue shirt" });
  });

  it("labels a pin by the nearest place: its name when at it, Near … within 250 m", async () => {
    await addPlace("Volta Hall", VOLTA);
    const { token } = await rider();
    const res = await book(token, {
      type: "LONE",
      pickup: { latitude: VOLTA.latitude + 0.0002, longitude: VOLTA.longitude }, // ~22 m
      dropoff: { latitude: VOLTA.latitude + 0.0015, longitude: VOLTA.longitude }, // ~166 m
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ride).toMatchObject({ pickupLabel: "Volta Hall", pickupPlaceId: null, dropoffLabel: "Near Volta Hall" });
  });

  it("keeps a chosen place's name when the rider nudges the pin, but not once it's dragged far away", async () => {
    const balme = await addPlace("Balme Library", BALME);
    const { token } = await rider();
    const nudged = await book(token, {
      type: "LONE",
      pickup: { placeId: balme.id, latitude: BALME.latitude + 0.001, longitude: BALME.longitude }, // ~110 m
      dropoff: NIGHT_MARKET,
    });
    expect(nudged.json().ride).toMatchObject({ pickupLabel: "Balme Library", pickupPlaceId: balme.id });

    const other = await rider();
    const dragged = await book(other.token, {
      type: "LONE",
      pickup: { placeId: balme.id, latitude: BALME.latitude + 0.004, longitude: BALME.longitude }, // ~440 m
      dropoff: NIGHT_MARKET,
    });
    expect(dragged.json().ride).toMatchObject({ pickupPlaceId: null, pickupLabel: PINNED_LOCATION_LABEL });
  });

  it("allows two pins in the same zone, refusing only the same spot", async () => {
    const { token } = await rider();
    const near = { latitude: BALME.latitude + 0.0005, longitude: BALME.longitude }; // ~55 m
    const tooClose = await book(token, { type: "LONE", pickup: BALME, dropoff: near });
    expect(tooClose.statusCode).toBe(400);
    expect(tooClose.json()).toMatchObject({ code: "TRIP_TOO_SHORT" });

    // Two spots ~150 m apart that share a zone (found, not assumed: the
    // seeded zone centres are close together).
    const [here, there] = sameZonePair(150);
    expect(nearestZone(here.latitude, here.longitude, zones)!.id).toBe(nearestZone(there.latitude, there.longitude, zones)!.id);
    const ok = await book(token, { type: "LONE", pickup: here, dropoff: there });
    expect(ok.statusCode).toBe(201);
  });

  it("refuses a pickup or drop-off outside the service area, saying which and why", async () => {
    const { token } = await rider();
    const pickupOut = await book(token, { type: "LONE", pickup: KUMASI, dropoff: BALME });
    expect(pickupOut.statusCode).toBe(422);
    expect(pickupOut.json()).toMatchObject({ code: "OUTSIDE_SERVICE_AREA", end: "pickup" });
    expect(pickupOut.json().error).toMatch(/^That pickup is outside campus/);

    const dropoffOut = await book(token, { type: "LONE", pickup: BALME, dropoff: KUMASI });
    expect(dropoffOut.json()).toMatchObject({ code: "OUTSIDE_SERVICE_AREA", end: "dropoff" });

    // Off campus is a future feature: Accra Mall is refused, the campus's far south is fine.
    expect((await book(token, { type: "LONE", pickup: BALME, dropoff: ACCRA_MALL })).statusCode).toBe(422);
    expect((await book(token, { type: "LONE", pickup: BALME, dropoff: UGMC })).statusCode).toBe(201);
  });

  it("refuses an unknown or deactivated place, and malformed input", async () => {
    const gone = await addPlace("Old Kiosk", NIGHT_MARKET);
    await prisma.place.update({ where: { id: gone.id }, data: { isActive: false } });
    const { token } = await rider();
    const res = await book(token, { type: "LONE", pickup: { placeId: gone.id }, dropoff: BALME });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: "PLACE_NOT_FOUND", end: "pickup" });

    expect((await book(token, { type: "LONE", pickup: { latitude: "5.6" }, dropoff: BALME })).statusCode).toBe(400);
    expect((await book(token, { type: "LONE", pickup: {}, dropoff: BALME })).statusCode).toBe(400);
    const longNote = await book(token, { type: "LONE", pickup: BALME, dropoff: NIGHT_MARKET, pickupNote: "x".repeat(141) });
    expect(longNote.statusCode).toBe(400);
    expect(longNote.json()).toMatchObject({ code: "NOTE_TOO_LONG" });
  });
});

describe("old app builds (zone ids only)", () => {
  it("book exactly as before: no pins, zones as sent, same-zone still refused", async () => {
    const { token } = await rider();
    const [a, b] = zones;
    const res = await book(token, { type: "SHARED", pickupZoneId: a!.id, dropoffZoneId: b!.id });
    expect(res.statusCode).toBe(201);
    const { ride } = res.json();
    expect(ride).toMatchObject({ pickupZoneId: a!.id, dropoffZoneId: b!.id, pickupLat: null, pickupLabel: null, dropoffLat: null });

    const same = await book((await rider()).token, { type: "LONE", pickupZoneId: a!.id, dropoffZoneId: a!.id });
    expect(same.statusCode).toBe(400);
  });

  it("see null pins on their ride, which the apps draw at the zone centre", async () => {
    const { token } = await rider();
    const created = (await book(token, { type: "LONE", pickupZoneId: zones[0]!.id, dropoffZoneId: zones[1]!.id })).json().ride;
    const res = await get(`/rides/${created.id}`, token);
    expect(res.statusCode).toBe(200);
    for (const key of COORD_KEYS) expect(res.json().ride[key]).toBeNull();
  });
});

describe("who sees the pins", () => {
  it("the driver's request list and broadcast give place names, never coordinates", async () => {
    await addPlace("Night Market", NIGHT_MARKET);
    const { token } = await rider();
    const pickup = { latitude: NIGHT_MARKET.latitude + 0.0001, longitude: NIGHT_MARKET.longitude + 0.0001 };
    const created = (await book(token, { type: "SHARED", pickup, dropoff: BALME })).json().ride;
    const driver = await onlineDriver(created.pickupZoneId);

    const list = await get("/driver/rides/eligible", driver.token);
    const item = list.json().rides.find((r: { rideId: string }) => r.rideId === created.id);
    expect(item).toMatchObject({ pickupPlaceName: "Night Market", dropoffPlaceName: PINNED_LOCATION_LABEL });
    for (const key of COORD_KEYS) expect(item).not.toHaveProperty(key);
    expect(mentions(list.body, pickup.latitude, pickup.longitude, BALME.latitude, BALME.longitude)).toBe(false);

    const emit = vi.spyOn(rideSocket, "emitDriverBroadcast").mockImplementation(() => {});
    await broadcastRide(prisma, created.id);
    const payload = emit.mock.calls.at(-1)![1];
    expect(payload).toMatchObject({ pickupPlaceName: "Night Market" });
    expect(mentions(JSON.stringify(payload), pickup.latitude, BALME.latitude)).toBe(false);
  });

  it("the assigned driver gets every rider's pins, labels and note", async () => {
    const { token } = await rider();
    const created = (await book(token, { type: "LONE", pickup: BALME, dropoff: NIGHT_MARKET, pickupNote: "Blue shirt" })).json().ride;
    const driver = await onlineDriver(created.pickupZoneId);
    expect((await app.inject({ method: "POST", url: `/rides/${created.id}/claim`, headers: { authorization: `Bearer ${driver.token}` } })).statusCode).toBe(200);

    const active = (await get("/driver/rides/active", driver.token)).json().ride;
    expect(active).toMatchObject({ pickupLat: BALME.latitude, dropoffLat: NIGHT_MARKET.latitude, pickupNote: "Blue shirt" });
    expect(active.passengers[0]).toMatchObject({ pickupLat: BALME.latitude, pickupLng: BALME.longitude, pickupNote: "Blue shirt" });
  });

  it("a rider sharing a car sees their own pins, not the others'", async () => {
    const owner = await rider();
    const anchor = (await book(owner.token, { type: "SHARED", pickup: BALME, dropoff: UGMC })).json().ride;
    const driver = await onlineDriver(anchor.pickupZoneId);
    await app.inject({ method: "POST", url: `/rides/${anchor.id}/claim`, headers: { authorization: `Bearer ${driver.token}` } });

    const joiner = await rider();
    const request = (await book(joiner.token, { type: "SHARED", pickup: VOLTA, dropoff: NIGHT_MARKET, pickupNote: "By the gate" })).json().ride;
    const add = await app.inject({
      method: "POST",
      url: `/rides/${anchor.id}/add-passenger`,
      headers: { authorization: `Bearer ${driver.token}` },
      payload: { requestRideId: request.id },
    });
    expect(add.statusCode).toBe(200);
    // The joiner's pins and note moved onto their new seat.
    const seat = await prisma.ridePassenger.findFirstOrThrow({ where: { rideId: anchor.id, riderId: joiner.user.id } });
    expect(seat).toMatchObject({ pickupLat: VOLTA.latitude, dropoffLat: NIGHT_MARKET.latitude, pickupNote: "By the gate" });

    const seenByJoiner = (await get(`/rides/${anchor.id}`, joiner.token)).json().ride;
    for (const key of COORD_KEYS) expect(seenByJoiner[key]).toBeNull(); // the ride-level pins are the owner's
    const ownSeat = seenByJoiner.passengers.find((p: { riderId: string }) => p.riderId === joiner.user.id);
    const ownerSeat = seenByJoiner.passengers.find((p: { riderId: string }) => p.riderId === owner.user.id);
    expect(ownSeat).toMatchObject({ pickupLat: VOLTA.latitude, pickupNote: "By the gate" });
    expect(ownerSeat).toMatchObject({ pickupLat: null, pickupLabel: null, dropoffLat: null, pickupNote: null });
    expect(mentions(JSON.stringify(seenByJoiner), BALME.latitude, UGMC.latitude)).toBe(false);

    const active = (await get("/rides/active", joiner.token)).json().ride;
    expect(active).toMatchObject({ pickupLat: VOLTA.latitude, dropoffLat: NIGHT_MARKET.latitude });

    const seenByOwner = (await get(`/rides/${anchor.id}`, owner.token)).json().ride;
    expect(seenByOwner).toMatchObject({ pickupLat: BALME.latitude });
    const joinerAsSeenByOwner = seenByOwner.passengers.find((p: { riderId: string }) => p.riderId === joiner.user.id);
    expect(joinerAsSeenByOwner.pickupLat).toBeNull();
  });

  it("the add-rider preview shows the new rider at the named place, not their pin", async () => {
    await addPlace("Night Market", NIGHT_MARKET);
    const owner = await rider();
    const anchor = (await book(owner.token, { type: "SHARED", pickup: BALME, dropoff: UGMC })).json().ride;
    const driver = await onlineDriver(anchor.pickupZoneId);
    await app.inject({ method: "POST", url: `/rides/${anchor.id}/claim`, headers: { authorization: `Bearer ${driver.token}` } });

    const joiner = await rider();
    const exactPin = { latitude: NIGHT_MARKET.latitude + 0.0004, longitude: NIGHT_MARKET.longitude - 0.0003 }; // ~55 m off
    const request = (await book(joiner.token, { type: "SHARED", pickup: exactPin, dropoff: VOLTA })).json().ride;

    const res = await get(`/rides/${anchor.id}/add-preview?requestRideId=${request.id}`, driver.token);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const newPickup = body.stops.find((s: { isNew: boolean; kind: string }) => s.isNew && s.kind === "PICKUP");
    expect(newPickup).toMatchObject({ label: "Near Night Market", latitude: NIGHT_MARKET.latitude, longitude: NIGHT_MARKET.longitude });
    // The car's own rider is shown at her real pin.
    const ownPickup = body.stops.find((s: { isNew: boolean; kind: string }) => !s.isNew && s.kind === "PICKUP");
    expect(ownPickup).toMatchObject({ latitude: BALME.latitude, longitude: BALME.longitude });
    // Neither the stops nor the drawn line give the new rider's pin away.
    expect(mentions(res.body, exactPin.latitude, exactPin.longitude)).toBe(false);
    for (const p of decodePolyline(body.proposedPolyline)) {
      expect(Math.abs(p.latitude - exactPin.latitude) < 1e-5 && Math.abs(p.longitude - exactPin.longitude) < 1e-5).toBe(false);
    }
  });

  it("the public /track page shows place names and no coordinates", async () => {
    await addPlace("Balme Library", BALME);
    const { token } = await rider();
    const created = (await book(token, { type: "LONE", pickup: BALME, dropoff: NIGHT_MARKET })).json().ride;
    // A link from before per-rider links: the ride's own (legacy) token.
    const legacyToken = randomBytes(16).toString("hex");
    await prisma.ride.update({ where: { id: created.id }, data: { trackingToken: legacyToken } });

    const res = await app.inject({ method: "GET", url: `/track/${legacyToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Balme Library");
    expect(mentions(res.body, BALME.latitude, BALME.longitude, NIGHT_MARKET.latitude, NIGHT_MARKET.longitude)).toBe(false);
    expect(res.body).not.toMatch(/-?\d+\.\d{4,}/); // no coordinate-like numbers at all
  });
});

describe("place search", () => {
  it("finds places by name and alias, with typos, and never inactive ones", async () => {
    await addPlace(`${MARK} Commonwealth Hall`, { latitude: 5.6508, longitude: -0.19267 }, ["Vandals"]);
    const hidden = await addPlace(`${MARK} Closed Canteen`, NIGHT_MARKET);
    await prisma.place.update({ where: { id: hidden.id }, data: { isActive: false } });
    const { token } = await rider();

    const typo = await get(`/places/search?q=${encodeURIComponent("commonweath")}`, token);
    expect(typo.statusCode).toBe(200);
    expect(typo.json().places.map((p: { name: string }) => p.name)).toContain(`${MARK} Commonwealth Hall`);
    expect(typo.json().attribution).toBe("© OpenStreetMap contributors");
    expect((await get("/places/search?q=vandals", token)).json().places[0].name).toBe(`${MARK} Commonwealth Hall`);
    expect((await get("/places/search?q=closed%20canteen", token)).json().places).toEqual([]);

    const all = (await get("/places", token)).json().places as Array<{ id: string; source?: string }>;
    expect(all.some((p) => p.id === hidden.id)).toBe(false);
    expect(all[0]).not.toHaveProperty("source");
  });

  it("serves the service area polygon", async () => {
    const { token } = await rider();
    const res = await get("/service-area", token);
    expect(res.json().polygon.length).toBeGreaterThan(10);
    expect(res.json().polygon[0]).toHaveProperty("latitude");
  });
});

describe("admin Places", () => {
  it("adds, renames, moves (recomputing the zone) and deactivates a place, audit-logging each", async () => {
    const { user, token } = await admin();
    const auth = { authorization: `Bearer ${token}` };

    const created = await app.inject({
      method: "POST",
      url: "/admin/places",
      headers: auth,
      payload: { name: `${MARK} New Kiosk`, aliases: ["kiosk", " kiosk "], latitude: BALME.latitude, longitude: BALME.longitude, category: "FOOD" },
    });
    expect(created.statusCode).toBe(201);
    const place = created.json().place;
    placeIds.push(place.id);
    expect(place).toMatchObject({ aliases: ["kiosk"], category: "FOOD", zoneId: nearestZone(BALME.latitude, BALME.longitude, zones)!.id });

    const patch = (payload: Record<string, unknown>) =>
      app.inject({ method: "PATCH", url: `/admin/places/${place.id}`, headers: auth, payload });

    expect((await patch({ name: `${MARK} Balme Kiosk` })).json().place.name).toBe(`${MARK} Balme Kiosk`);
    const moved = (await patch({ latitude: UGMC.latitude, longitude: UGMC.longitude })).json().place;
    expect(moved.zoneId).toBe(nearestZone(UGMC.latitude, UGMC.longitude, zones)!.id);
    expect((await patch({ isActive: false })).json().place.isActive).toBe(false);
    expect((await patch({ latitude: KUMASI.latitude, longitude: KUMASI.longitude })).statusCode).toBe(400);
    expect((await patch({ category: "PALACE" })).statusCode).toBe(400);

    const log = await prisma.adminAuditLog.findMany({ where: { actor: user.id, target: place.id }, orderBy: { timestamp: "asc" } });
    expect(log.map((l) => l.action)).toEqual(["place.create", "place.update", "place.move", "place.deactivate"]);
    expect(log[1]!.reason).toContain("Balme Kiosk");
    expect(log[2]!.reason).toMatch(/^moved: /);

    // Inactive places are still listed for admins (to reactivate), searchably.
    const listed = (await app.inject({ method: "GET", url: `/admin/places?q=${encodeURIComponent("balme kiosk")}`, headers: auth })).json().places;
    expect(listed.map((p: { id: string }) => p.id)).toContain(place.id);
  });

  it("is admins only", async () => {
    const { token } = await rider();
    const res = await app.inject({ method: "POST", url: "/admin/places", headers: { authorization: `Bearer ${token}` }, payload: { name: "x", ...BALME } });
    expect(res.statusCode).toBe(403);
  });
});

describe("routes between pins", () => {
  const post = (token: string, points: unknown) =>
    app.inject({ method: "POST", url: "/routes/legs", headers: { authorization: `Bearer ${token}` }, payload: { points } });

  it("asks OSRM once through all the points, then serves the stored route", async () => {
    const { token } = await rider();
    const calls: number[] = [];
    setRouteFetcherForTests(async (points) => {
      calls.push(points.length);
      return {
        polyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
        distanceMeters: 2500,
        durationSeconds: 400,
        legs: [
          { distanceMeters: 1000, durationSeconds: 150 },
          { distanceMeters: 1500, durationSeconds: 250 },
        ],
      };
    });
    const points = [BALME, VOLTA, { latitude: 5.6377, longitude: -0.18 }];
    const first = await post(token, points);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ source: "osrm", durationSeconds: 400, legs: [{ durationSeconds: 150 }, { durationSeconds: 250 }] });
    expect(first.json().attribution).toContain("OSRM");

    // Same points (within ~11 m): from memory, then from the table after a restart.
    const nudged = points.map((p) => ({ latitude: p.latitude + 0.00001, longitude: p.longitude }));
    expect((await post(token, nudged)).json().source).toBe("osrm");
    setRouteFetcherForTests(async () => {
      throw new Error("must not be called");
    });
    expect((await post(token, points)).json()).toMatchObject({ source: "osrm", durationSeconds: 400 });
    expect(calls).toEqual([3]);
  });

  it("falls back to the stored zone roads, ending at the pins, when OSRM fails — and doesn't keep the fallback", async () => {
    const { token } = await rider();
    setRouteFetcherForTests(async () => {
      throw new Error("timeout");
    });
    const points = [NIGHT_MARKET, UGMC];
    const res = await post(token, points);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("zones");
    expect(body.legs).toHaveLength(1);
    const line = decodePolyline(body.polyline);
    expect(line[0]!.latitude).toBeCloseTo(NIGHT_MARKET.latitude, 5);
    expect(line.at(-1)!.longitude).toBeCloseTo(UGMC.longitude, 4); // polylines keep 5 decimals

    let called = false;
    setRouteFetcherForTests(async () => {
      called = true;
      return null;
    });
    await post(token, points);
    expect(called).toBe(true); // the fallback wasn't cached: OSRM is tried again
  });

  it("refuses too few or too many points, and stops outside the area", async () => {
    const { token } = await rider();
    expect((await post(token, [BALME])).statusCode).toBe(400);
    expect((await post(token, Array(11).fill(BALME))).statusCode).toBe(400);
    expect((await post(token, [BALME, KUMASI])).statusCode).toBe(422);
    // The first point may be a driver just outside the area.
    setRouteFetcherForTests(async () => null);
    expect((await post(token, [{ latitude: 5.68, longitude: -0.18 }, BALME])).statusCode).toBe(200);
  });
});
