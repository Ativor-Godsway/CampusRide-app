/**
 * Phase 1 — cash-only lockdown.
 *
 * Covers the three gates added in this phase (initiate-payment's cash-only
 * response, the USSD callback 404) plus the end-to-end CASH ride that must
 * keep producing a 15% CommissionLedger debt row. The Moolre webhook's
 * disabled-gate lives alongside its own tests in webhooks.test.ts.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getLoneFare, splitFare } from "@rida/shared";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerRideRoutes } from "./rides";
import { registerDriverRoutes } from "./driver";
import { registerUssdRoutes } from "./ussd";
import { signAccessToken } from "../services/auth/tokens";
import {
  createTestDriver,
  createTestRide,
  createTestUser,
  getTestZones,
  cleanupDriver,
  cleanupRide,
} from "../services/ride/testFixtures";

let app: FastifyInstance;
const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerRideRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  // Default `enabled` — ENABLE_USSD is unset in .env.test, so this is the
  // real production-default wiring, not a test-only override.
  registerUssdRoutes(app, prisma);
  await app.ready();
});

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function authedRider() {
  const rider = await createTestUser("RIDER");
  return { rider, token: signAccessToken({ userId: rider.id, role: "RIDER" }) };
}

async function authedDriver() {
  const { user } = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

describe("POST /rides/:id/initiate-payment — cash-only launch", () => {
  it("returns the typed cash-only refusal instead of falling through to DummyPaymentService", async () => {
    expect(config.moolre.enabled).toBe(false);

    const { rider, token } = await authedRider();
    const { ride } = await createTestRide({ type: "LONE", status: "COMPLETED" });
    createdRideIds.push(ride.id);

    const res = await app.inject({
      method: "POST",
      url: `/rides/${ride.id}/initiate-payment`,
      headers: { authorization: `Bearer ${token}` },
      payload: { phone: "+233200000001", network: "MTN" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "Digital payments are disabled — please pay the driver in cash.",
      code: "PAYMENTS_CASH_ONLY",
      paymentMode: "CASH_ONLY",
    });

    // The old fall-through created a PENDING Payment row nothing would ever
    // resolve. Nothing must be written now.
    const payments = await prisma.payment.findMany({ where: { rideId: ride.id } });
    expect(payments).toHaveLength(0);
    expect(rider.id).toBeTruthy();
  });

  it("answers cash-only before any ride/state validation (even for a ride the caller can't see)", async () => {
    const { token } = await authedRider();

    const res = await app.inject({
      method: "POST",
      url: "/rides/does-not-exist/initiate-payment",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("PAYMENTS_CASH_ONLY");
  });

  it("still requires auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/rides/any/initiate-payment",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /ussd/callback — USSD shelved", () => {
  it("defaults to disabled (ENABLE_USSD unset)", () => {
    expect(config.enableUssd).toBe(false);
  });

  it("404s while disabled, so no unverified rider account can be auto-provisioned", async () => {
    const msisdn = "+233209999123";
    const before = await prisma.user.count({ where: { phone: msisdn } });

    const res = await app.inject({
      method: "POST",
      url: "/ussd/callback",
      payload: { sessionId: "sess-cash-only-1", new: true, msisdn, message: "" },
    });

    expect(res.statusCode).toBe(404);
    expect(await prisma.user.count({ where: { phone: msisdn } })).toBe(before);
  });

  it("is registered again when the flag is on (the code is dormant, not deleted)", async () => {
    const enabledApp = Fastify();
    registerUssdRoutes(enabledApp, prisma, true);
    await enabledApp.ready();

    const res = await enabledApp.inject({
      method: "POST",
      url: "/ussd/callback",
      payload: { sessionId: "sess-cash-only-2", new: true, message: "" },
    });

    // 200 (the handler's own "missing msisdn" response), not 404 — proves the
    // route exists and only the flag was keeping it closed.
    expect(res.statusCode).toBe(200);
    await enabledApp.close();
  });
});

describe("paymentMethod defaults to CASH (cash-only launch)", () => {
  it("POST /rides with no paymentMethod comes back CASH", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: { pickupZoneId: pickup.id, dropoffZoneId: dropoff.id, type: "LONE" },
    });

    expect(res.statusCode).toBe(201);
    const ride = res.json().ride;
    createdRideIds.push(ride.id as string);
    expect(ride.paymentMethod).toBe("CASH");

    // Confirm it's persisted that way, not just echoed by the handler.
    const persisted = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(persisted.paymentMethod).toBe("CASH");
  });

  it("falls back to CASH when paymentMethod is present but invalid", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        type: "LONE",
        paymentMethod: "BITCOIN",
      },
    });

    expect(res.statusCode).toBe(201);
    createdRideIds.push(res.json().ride.id as string);
    expect(res.json().ride.paymentMethod).toBe("CASH");
  });

  it("the schema-level column default is CASH (covers the migration, not just the handler)", async () => {
    // createTestRide never sets paymentMethod, so this row takes the database
    // default written by 20260923120000_ride_payment_method_default_cash.
    const { ride } = await createTestRide({ type: "LONE" });
    createdRideIds.push(ride.id);
    expect(ride.paymentMethod).toBe("CASH");
  });

  it("an explicit MOMO ride is still accepted (the column is not narrowed, only its default)", async () => {
    const { token } = await authedRider();
    const { pickup, dropoff } = await getTestZones();

    const res = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        type: "LONE",
        paymentMethod: "MOMO",
      },
    });

    expect(res.statusCode).toBe(201);
    createdRideIds.push(res.json().ride.id as string);
    expect(res.json().ride.paymentMethod).toBe("MOMO");
  });
});

describe("CASH ride end-to-end — CommissionLedger still records the 15% debt", () => {
  it("creates exactly one ledger row at 15% of the lone fare on completion", async () => {
    const { token: riderToken } = await authedRider();
    const { user: driver, token: driverToken } = await authedDriver();
    const { pickup, dropoff } = await getTestZones();

    const createRes = await app.inject({
      method: "POST",
      url: "/rides",
      headers: { authorization: `Bearer ${riderToken}` },
      payload: {
        pickupZoneId: pickup.id,
        dropoffZoneId: dropoff.id,
        type: "LONE",
        paymentMethod: "CASH",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const rideId = createRes.json().ride.id as string;
    createdRideIds.push(rideId);

    const driverAuth = { authorization: `Bearer ${driverToken}` };
    for (const step of ["claim", "arrived", "depart"]) {
      const res = await app.inject({
        method: "POST",
        url: `/rides/${rideId}/${step}`,
        headers: driverAuth,
      });
      expect(res.statusCode, `${step} failed: ${res.body}`).toBe(200);
    }

    const completeRes = await app.inject({
      method: "POST",
      url: `/rides/${rideId}/complete`,
      headers: driverAuth,
    });
    expect(completeRes.statusCode).toBe(200);
    expect(completeRes.json().ride.status).toBe("COMPLETED");

    const { commission, driverShare } = splitFare(getLoneFare());
    expect(completeRes.json().driverSharePesewas).toBe(driverShare);

    const ledgerRows = await prisma.commissionLedger.findMany({ where: { rideId } });
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]!.amountPesewas).toBe(commission);
    expect(ledgerRows[0]!.driverUserId).toBe(driver.id);
    // 15% of the total fare — the unenforced debt record kept in this phase.
    expect(ledgerRows[0]!.amountPesewas).toBe(Math.round(getLoneFare() * 0.15));

    // Cash rides create no Payment rows at all.
    expect(await prisma.payment.count({ where: { rideId } })).toBe(0);
  });
});
