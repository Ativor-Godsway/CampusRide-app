import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { registerWebhookRoutes } from "./webhooks";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { TX_STATUS } from "../services/payment/constants";
import { collectionExternalRef, initiateCollection } from "../services/payment/paymentFlow";
import { createTestDriver, createTestRide, cleanupRide, cleanupDriver } from "../services/ride/testFixtures";

const WEBHOOK_SECRET = "test-webhook-secret";

let app: FastifyInstance;
let paymentService: DummyPaymentService;

const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];

beforeAll(async () => {
  paymentService = new DummyPaymentService();
  app = Fastify();
  registerWebhookRoutes(app, prisma, paymentService, WEBHOOK_SECRET);
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

/** Creates a SHARED, IN_PROGRESS ride with a driver, one passenger, and a PENDING collection Payment row. */
async function setupRideWithPendingCollection(lockedFare: number) {
  const driver = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(driver.user.id);

  const { ride, rider } = await createTestRide({
    type: "SHARED",
    status: "IN_PROGRESS",
    occupancy: 1,
    driverId: driver.user.id,
  });
  createdRideIds.push(ride.id);

  await prisma.ridePassenger.create({
    data: {
      rideId: ride.id,
      riderId: rider.id,
      pickupZoneId: ride.pickupZoneId,
      dropoffZoneId: ride.dropoffZoneId,
      status: "WAITING",
      lockedFare,
    },
  });

  await initiateCollection(prisma, paymentService, {
    rideId: ride.id,
    riderId: rider.id,
    amountPesewas: lockedFare,
    payerPhone: "+233200000099",
    channel: "MTN",
  });

  return { driver, ride, rider, externalRef: collectionExternalRef(ride.id, rider.id) };
}

describe("POST /webhooks/moolre", () => {
  it("rejects a missing secret with 401 and makes no state change", async () => {
    const { ride, externalRef } = await setupRideWithPendingCollection(1000);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/moolre",
      payload: { data: { txstatus: TX_STATUS.SUCCESS, externalref: externalRef } },
    });

    expect(res.statusCode).toBe(401);
    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
    expect(payment.status).toBe("PENDING");
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("PENDING");
  });

  it("rejects a wrong secret with 401 and makes no state change", async () => {
    const { ride, externalRef } = await setupRideWithPendingCollection(1000);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/moolre",
      payload: { data: { txstatus: TX_STATUS.SUCCESS, externalref: externalRef, secret: "wrong-secret" } },
    });

    expect(res.statusCode).toBe(401);
    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
    expect(payment.status).toBe("PENDING");
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("PENDING");
  });

  it("returns 404 for a valid secret but unknown externalref", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/moolre",
      payload: { data: { txstatus: TX_STATUS.SUCCESS, externalref: "collect:no-such-ride:no-such-rider", secret: WEBHOOK_SECRET } },
    });

    expect(res.statusCode).toBe(404);
  });

  it("PENDING (0) and UNKNOWN (3) with a valid secret return 200 but make no state change", async () => {
    const { ride, externalRef } = await setupRideWithPendingCollection(1000);

    for (const txstatus of [TX_STATUS.PENDING, TX_STATUS.UNKNOWN]) {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/moolre",
        payload: { data: { txstatus, externalref: externalRef, secret: WEBHOOK_SECRET } },
      });
      expect(res.statusCode).toBe(200);
    }

    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
    expect(payment.status).toBe("PENDING");
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("PENDING");
  });

  it("FAILED (2) with a valid secret marks the Payment and ride paymentStatus FAILED", async () => {
    const { ride, externalRef } = await setupRideWithPendingCollection(1000);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/moolre",
      payload: { data: { txstatus: TX_STATUS.FAILED, externalref: externalRef, secret: WEBHOOK_SECRET } },
    });

    expect(res.statusCode).toBe(200);
    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
    expect(payment.status).toBe("FAILED");
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("FAILED");
  });

  it("SUCCESS (1) with a valid secret, single passenger: collects, advances to COLLECTED then DISBURSED via the driver disbursement", async () => {
    const { ride, driver, externalRef } = await setupRideWithPendingCollection(1000);

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/moolre",
      payload: { data: { txstatus: TX_STATUS.SUCCESS, externalref: externalRef, secret: WEBHOOK_SECRET } },
    });

    expect(res.statusCode).toBe(200);
    const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
    expect(payment.status).toBe("SUCCESS");

    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("DISBURSED");

    const disbursement = await prisma.payment.findFirstOrThrow({ where: { rideId: ride.id, type: "DISBURSEMENT" } });
    expect(disbursement.status).toBe("SUCCESS");
    expect(disbursement.riderId).toBe(driver.user.id);
  });
});
