import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { splitFare } from "@rida/shared";
import { DummyPaymentService } from "./DummyPaymentService";
import { TX_STATUS } from "./constants";
import {
  collectionExternalRef,
  disbursementExternalRef,
  getRidePaymentSummary,
  handleCollectionWebhook,
  initiateCollection,
  initiateRideCollections,
  isValidWebhookSecret,
  type DisbursementRecipient,
} from "./paymentFlow";
import { UnknownPaymentReferenceError } from "./errors";
import { applyRideTransition } from "../ride/rideService";
import type { CollectParams, CollectResult, PaymentService } from "./PaymentService";
import { createTestDriver, createTestRide, cleanupRide, cleanupDriver } from "../ride/testFixtures";

const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];
const extraUserIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
  while (extraUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: extraUserIds.pop()! } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

const WEBHOOK_SECRET = "test-webhook-secret";

function resolveDriverFor(driver: { user: { id: string; phone: string } }) {
  return (driverUserId: string): Promise<DisbursementRecipient> =>
    Promise.resolve({ driverUserId, phone: driver.user.phone, channel: "MTN" });
}

/** Creates a SHARED, IN_PROGRESS ride with a driver and one passenger (the ride's own rider) with the given lockedFare. */
async function createDepartedRideWithOnePassenger(lockedFare: number) {
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

  return { driver, ride, rider };
}

/** Creates a SHARED, IN_PROGRESS ride with a driver and N passengers, each with the given lockedFare. */
async function createDepartedRideWithPassengers(lockedFares: number[]) {
  const driver = await createTestDriver({ isOnline: true, isApproved: true });
  createdDriverUserIds.push(driver.user.id);

  const { ride, rider: rider1 } = await createTestRide({
    type: "SHARED",
    status: "IN_PROGRESS",
    occupancy: lockedFares.length,
    driverId: driver.user.id,
  });
  createdRideIds.push(ride.id);

  const riders = [rider1];
  for (let i = 1; i < lockedFares.length; i++) {
    const rider = await prisma.user.create({
      data: { phone: `+233-pay-test-${Date.now()}-${i}`, name: `Phase4c Test Rider ${i}`, role: "RIDER" },
    });
    extraUserIds.push(rider.id);
    riders.push(rider);
  }

  for (let i = 0; i < lockedFares.length; i++) {
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: riders[i]!.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "WAITING",
        lockedFare: lockedFares[i]!,
      },
    });
  }

  return { driver, ride, riders };
}

describe("isValidWebhookSecret", () => {
  it("accepts a matching secret", () => {
    expect(isValidWebhookSecret({ secret: WEBHOOK_SECRET }, WEBHOOK_SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(isValidWebhookSecret({ secret: "wrong" }, WEBHOOK_SECRET)).toBe(false);
  });

  it("rejects a missing secret", () => {
    expect(isValidWebhookSecret({}, WEBHOOK_SECRET)).toBe(false);
  });
});

describe("externalRef helpers", () => {
  it("collectionExternalRef is deterministic per ride+rider", () => {
    expect(collectionExternalRef("ride-1", "rider-1")).toBe("collect:ride-1:rider-1");
    expect(collectionExternalRef("ride-1", "rider-1")).toBe(collectionExternalRef("ride-1", "rider-1"));
  });

  it("disbursementExternalRef is deterministic per ride+driver+rider (per-rider, Phase 4c)", () => {
    expect(disbursementExternalRef("ride-1", "driver-1", "rider-1")).toBe("disburse:ride-1:driver-1:rider-1");
    expect(disbursementExternalRef("ride-1", "driver-1", "rider-2")).toBe("disburse:ride-1:driver-1:rider-2");
  });
});

describe("initiateCollection", () => {
  it("creates a PENDING Payment row and is idempotent on externalRef", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);
    const paymentService = new DummyPaymentService();

    const first = await initiateCollection(prisma, paymentService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000010",
      channel: "MTN",
    });
    expect(first.status).toBe("PENDING");
    expect(first.type).toBe("COLLECTION");
    expect(first.providerRef).toBe(collectionExternalRef(ride.id, rider.id));

    const second = await initiateCollection(prisma, paymentService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000010",
      channel: "MTN",
    });
    expect(second.id).toBe(first.id);

    const rows = await prisma.payment.findMany({ where: { rideId: ride.id, type: "COLLECTION" } });
    expect(rows).toHaveLength(1);
  });

  it("marks the Payment FAILED only when the provider returns a definite failure (txstatus 2)", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const failingService: PaymentService = {
      collect: async (params: CollectParams): Promise<CollectResult> => ({
        txstatus: TX_STATUS.FAILED,
        externalRef: params.externalRef,
      }),
      validateRecipient: async () => ({ accountName: "n/a" }),
      disburse: async (params) => ({ txstatus: TX_STATUS.SUCCESS, externalRef: params.externalRef }),
      getStatus: async (externalRef) => ({ txstatus: TX_STATUS.UNKNOWN, externalRef }),
    };

    const payment = await initiateCollection(prisma, failingService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000011",
      channel: "MTN",
    });
    expect(payment.status).toBe("FAILED");
  });

  it("leaves the Payment PENDING when the provider returns PENDING or UNKNOWN", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const unknownService: PaymentService = {
      collect: async (params: CollectParams): Promise<CollectResult> => ({
        txstatus: TX_STATUS.UNKNOWN,
        externalRef: params.externalRef,
      }),
      validateRecipient: async () => ({ accountName: "n/a" }),
      disburse: async (params) => ({ txstatus: TX_STATUS.SUCCESS, externalRef: params.externalRef }),
      getStatus: async (externalRef) => ({ txstatus: TX_STATUS.UNKNOWN, externalRef }),
    };

    const payment = await initiateCollection(prisma, unknownService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000012",
      channel: "MTN",
    });
    expect(payment.status).toBe("PENDING");
  });
});

describe("handleCollectionWebhook", () => {
  it("throws UnknownPaymentReferenceError for an unrecognized externalref", async () => {
    const paymentService = new DummyPaymentService();
    await expect(
      handleCollectionWebhook(
        prisma,
        paymentService,
        { txstatus: TX_STATUS.SUCCESS, externalref: "collect:does-not-exist:nobody" },
        async () => {
          throw new Error("should not be called");
        },
      ),
    ).rejects.toBeInstanceOf(UnknownPaymentReferenceError);
  });

  it("PENDING (0) and UNKNOWN (3) cause no state change", async () => {
    const { driver, ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const paymentService = new DummyPaymentService();
    await initiateCollection(prisma, paymentService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000020",
      channel: "MTN",
    });
    const externalRef = collectionExternalRef(ride.id, rider.id);

    for (const txstatus of [TX_STATUS.PENDING, TX_STATUS.UNKNOWN]) {
      await handleCollectionWebhook(prisma, paymentService, { txstatus, externalref: externalRef }, resolveDriverFor(driver));
      const payment = await prisma.payment.findFirstOrThrow({ where: { providerRef: externalRef } });
      expect(payment.status).toBe("PENDING");
      const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
      expect(updatedRide.paymentStatus).toBe("PENDING");
    }
  });

  it("FAILED (2) marks only that rider's Payment FAILED; the ride, driver, and other passengers are untouched", async () => {
    const { driver, ride, riders } = await createDepartedRideWithPassengers([700, 700]);
    const [rider1, rider2] = riders;

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000021", channel: "MTN" }));

    const ref1 = collectionExternalRef(ride.id, rider1.id);
    const ref2 = collectionExternalRef(ride.id, rider2.id);

    await handleCollectionWebhook(prisma, paymentService, { txstatus: TX_STATUS.FAILED, externalref: ref1 }, resolveDriverFor(driver));

    const payment1 = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref1 } });
    expect(payment1.status).toBe("FAILED");

    // Other rider's collection is untouched (still PENDING, not failed).
    const payment2 = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref2 } });
    expect(payment2.status).toBe("PENDING");

    // No disbursement was triggered for either rider.
    const disbursements = await prisma.payment.findMany({ where: { rideId: ride.id, type: "DISBURSEMENT" } });
    expect(disbursements).toHaveLength(0);

    // The ride's coarse paymentStatus reflects the failure (visible, not orphaned).
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("FAILED");

    // The ride's own status (not paymentStatus) is untouched.
    expect(updatedRide.status).toBe("IN_PROGRESS");
  });

  it("SUCCESS (1) for one rider: that Payment is marked SUCCESS and the driver is immediately disbursed 85% of that rider's fare; the other rider is unaffected", async () => {
    const { driver, ride, riders } = await createDepartedRideWithPassengers([700, 1300]);
    const [rider1, rider2] = riders;

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000022", channel: "MTN" }));

    const ref1 = collectionExternalRef(ride.id, rider1.id);
    const ref2 = collectionExternalRef(ride.id, rider2.id);

    await handleCollectionWebhook(prisma, paymentService, { txstatus: TX_STATUS.SUCCESS, externalref: ref1 }, resolveDriverFor(driver));

    const collection1 = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref1 } });
    expect(collection1.status).toBe("SUCCESS");

    const disbursement1Ref = disbursementExternalRef(ride.id, driver.user.id, rider1.id);
    const disbursement1 = await prisma.payment.findFirstOrThrow({ where: { providerRef: disbursement1Ref } });
    expect(disbursement1.status).toBe("SUCCESS");
    expect(disbursement1.type).toBe("DISBURSEMENT");
    expect(disbursement1.amount).toBe(splitFare(700).driverShare);

    // The second rider's collection and any disbursement for them are untouched.
    const collection2 = await prisma.payment.findFirstOrThrow({ where: { providerRef: ref2 } });
    expect(collection2.status).toBe("PENDING");
    const disbursement2Ref = disbursementExternalRef(ride.id, driver.user.id, rider2.id);
    expect(await prisma.payment.findFirst({ where: { providerRef: disbursement2Ref } })).toBeNull();

    // Ride paymentStatus is not yet fully settled (rider2 still pending).
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("PENDING");
  });

  it("a 3-rider ride where collections confirm one at a time produces 3 separate, exact 85% driver disbursements, all idempotent", async () => {
    const fares = [600, 900, 1500];
    const { driver, ride, riders } = await createDepartedRideWithPassengers(fares);

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000023", channel: "MTN" }));

    for (let i = 0; i < riders.length; i++) {
      const ref = collectionExternalRef(ride.id, riders[i]!.id);

      await handleCollectionWebhook(prisma, paymentService, { txstatus: TX_STATUS.SUCCESS, externalref: ref }, resolveDriverFor(driver));
      // Redeliver the same webhook — must not create a second disbursement.
      await handleCollectionWebhook(prisma, paymentService, { txstatus: TX_STATUS.SUCCESS, externalref: ref }, resolveDriverFor(driver));

      const disbursementRef = disbursementExternalRef(ride.id, driver.user.id, riders[i]!.id);
      const disbursementRows = await prisma.payment.findMany({ where: { providerRef: disbursementRef } });
      expect(disbursementRows).toHaveLength(1);
      expect(disbursementRows[0]!.status).toBe("SUCCESS");
      expect(disbursementRows[0]!.amount).toBe(splitFare(fares[i]!).driverShare);
    }

    const allDisbursements = await prisma.payment.findMany({ where: { rideId: ride.id, type: "DISBURSEMENT" } });
    expect(allDisbursements).toHaveLength(3);

    const totalDriverShare = allDisbursements.reduce((sum, d) => sum + d.amount, 0);
    const totalFare = fares.reduce((sum, f) => sum + f, 0);
    expect(totalDriverShare).toBe(splitFare(totalFare).driverShare);

    // All collections confirmed and all disbursed -> fully settled.
    const updatedRide = await prisma.ride.findUniqueOrThrow({ where: { id: ride.id } });
    expect(updatedRide.paymentStatus).toBe("DISBURSED");
  });
});

describe("getRidePaymentSummary", () => {
  it("reports correct totals and per-passenger states across mixed PENDING/COLLECTED/FAILED", async () => {
    const fares = [500, 800, 1200];
    const { driver, ride, riders } = await createDepartedRideWithPassengers(fares);

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000024", channel: "MTN" }));

    // rider 0: collected + disbursed. rider 1: failed. rider 2: still pending.
    await handleCollectionWebhook(
      prisma,
      paymentService,
      { txstatus: TX_STATUS.SUCCESS, externalref: collectionExternalRef(ride.id, riders[0]!.id) },
      resolveDriverFor(driver),
    );
    await handleCollectionWebhook(
      prisma,
      paymentService,
      { txstatus: TX_STATUS.FAILED, externalref: collectionExternalRef(ride.id, riders[1]!.id) },
      resolveDriverFor(driver),
    );

    const summary = await getRidePaymentSummary(prisma, ride.id);

    expect(summary.totalExpectedPesewas).toBe(500 + 800 + 1200);
    expect(summary.totalCollectedPesewas).toBe(500);
    expect(summary.totalDisbursedPesewas).toBe(splitFare(500).driverShare);
    expect(summary.hasFailures).toBe(true);
    expect(summary.fullySettled).toBe(false);

    const byRider = new Map(summary.perPassenger.map((p) => [p.riderId, p]));
    expect(byRider.get(riders[0]!.id)?.status).toBe("DISBURSED");
    expect(byRider.get(riders[0]!.id)?.disbursedPesewas).toBe(splitFare(500).driverShare);
    expect(byRider.get(riders[1]!.id)?.status).toBe("FAILED");
    expect(byRider.get(riders[2]!.id)?.status).toBe("PENDING");
  });

  it("a COMPLETED ride with a FAILED payment still surfaces the failure (not orphaned)", async () => {
    const { driver, ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000025", channel: "MTN" }));

    await handleCollectionWebhook(
      prisma,
      paymentService,
      { txstatus: TX_STATUS.FAILED, externalref: collectionExternalRef(ride.id, rider.id) },
      resolveDriverFor(driver),
    );

    // Ride proceeds to completion regardless of the failed payment.
    const completed = await applyRideTransition(prisma, ride.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");

    const summary = await getRidePaymentSummary(prisma, ride.id);
    expect(summary.hasFailures).toBe(true);
    expect(summary.perPassenger[0]!.status).toBe("FAILED");
    expect(summary.fullySettled).toBe(false);
  });

  it("a ride can be COMPLETED while a payment is still PENDING — completion does not error or wait on payment", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const paymentService = new DummyPaymentService();
    await initiateRideCollections(prisma, paymentService, ride.id, () => ({ phone: "+233200000026", channel: "MTN" }));

    const collection = await prisma.payment.findFirstOrThrow({ where: { providerRef: collectionExternalRef(ride.id, rider.id) } });
    expect(collection.status).toBe("PENDING");

    const completed = await applyRideTransition(prisma, ride.id, "COMPLETED");
    expect(completed.status).toBe("COMPLETED");

    const summary = await getRidePaymentSummary(prisma, ride.id);
    expect(summary.perPassenger[0]!.status).toBe("PENDING");
    expect(summary.hasFailures).toBe(false);
    expect(summary.fullySettled).toBe(false);
  });
});
