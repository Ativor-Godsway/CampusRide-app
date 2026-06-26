import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { collectionExternalRef, initiateCollection } from "./paymentFlow";
import { NoAwaitingOtpPaymentError } from "./errors";
import type { CollectOutcome, CollectParams, PaymentService } from "./PaymentService";
import { createTestDriver, createTestRide, cleanupRide, cleanupDriver } from "../ride/testFixtures";

const createdRideIds: string[] = [];
const createdDriverUserIds: string[] = [];

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await cleanupRide(createdRideIds.pop()!);
  }
  while (createdDriverUserIds.length > 0) {
    await cleanupDriver(createdDriverUserIds.pop()!);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

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

const unimplemented = (name: string) => async () => {
  throw new Error(`${name} should not be called in this test`);
};

function stubService(collect: PaymentService["collect"]): PaymentService {
  return {
    collect,
    validateRecipient: unimplemented("validateRecipient"),
    disburse: unimplemented("disburse"),
    getStatus: unimplemented("getStatus"),
  };
}

describe("initiateCollection — OTP flow (Phase 3b)", () => {
  it("first call: collect() returning OTP_REQUIRED leaves the Payment row AWAITING_OTP", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const otpRequiredService = stubService(async (params: CollectParams): Promise<CollectOutcome> => ({
      kind: "OTP_REQUIRED",
      externalRef: params.externalRef,
    }));

    const payment = await initiateCollection(prisma, otpRequiredService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000031",
      channel: "MTN",
    });

    expect(payment.status).toBe("AWAITING_OTP");
  });

  it("second call with a wrong otpcode: collect() returns OTP_REQUIRED again, row stays AWAITING_OTP (not a failure)", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const alwaysOtpRequired = stubService(async (params: CollectParams): Promise<CollectOutcome> => ({
      kind: "OTP_REQUIRED",
      externalRef: params.externalRef,
    }));

    const first = await initiateCollection(prisma, alwaysOtpRequired, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000032",
      channel: "MTN",
    });
    expect(first.status).toBe("AWAITING_OTP");

    const retry = await initiateCollection(prisma, alwaysOtpRequired, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000032",
      channel: "MTN",
      otpcode: "000000",
    });

    expect(retry.status).toBe("AWAITING_OTP");
    expect(retry.id).toBe(first.id);
  });

  it("second call advancing past OTP: collect() returns PROMPT_SENT, row moves to PENDING and persists providerTxId", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    let call = 0;
    const otpThenSuccess = stubService(async (params: CollectParams): Promise<CollectOutcome> => {
      call += 1;
      if (call === 1) return { kind: "OTP_REQUIRED", externalRef: params.externalRef };
      return { kind: "PROMPT_SENT", externalRef: params.externalRef, providerTxId: "moolre-tx-123" };
    });

    const first = await initiateCollection(prisma, otpThenSuccess, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000033",
      channel: "MTN",
    });
    expect(first.status).toBe("AWAITING_OTP");

    const confirmed = await initiateCollection(prisma, otpThenSuccess, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000033",
      channel: "MTN",
      otpcode: "123456",
    });

    expect(confirmed.status).toBe("PENDING");
    expect(confirmed.providerTxId).toBe("moolre-tx-123");
  });

  it("otpcode with no existing Payment row: throws NoAwaitingOtpPaymentError and never calls Moolre", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);
    const neverCalled = stubService(unimplemented("collect"));

    await expect(
      initiateCollection(prisma, neverCalled, {
        rideId: ride.id,
        riderId: rider.id,
        amountPesewas: 1000,
        payerPhone: "+233200000034",
        channel: "MTN",
        otpcode: "123456",
      }),
    ).rejects.toThrow(NoAwaitingOtpPaymentError);

    const rows = await prisma.payment.findMany({
      where: { providerRef: collectionExternalRef(ride.id, rider.id) },
    });
    expect(rows).toHaveLength(0);
  });

  it("otpcode against an existing non-AWAITING_OTP row (PENDING): throws NoAwaitingOtpPaymentError and never re-calls Moolre", async () => {
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const promptSentService = stubService(async (params: CollectParams): Promise<CollectOutcome> => ({
      kind: "PROMPT_SENT",
      externalRef: params.externalRef,
    }));

    const first = await initiateCollection(prisma, promptSentService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000035",
      channel: "MTN",
    });
    expect(first.status).toBe("PENDING");

    const neverCalled = stubService(unimplemented("collect"));
    await expect(
      initiateCollection(prisma, neverCalled, {
        rideId: ride.id,
        riderId: rider.id,
        amountPesewas: 1000,
        payerPhone: "+233200000035",
        channel: "MTN",
        otpcode: "123456",
      }),
    ).rejects.toThrow(NoAwaitingOtpPaymentError);
  });

  it("genuine duplicate re-submit (no otpcode) still short-circuits without re-calling Moolre", async () => {
    let calls = 0;
    const { ride, rider } = await createDepartedRideWithOnePassenger(1000);

    const countingService = stubService(async (params: CollectParams): Promise<CollectOutcome> => {
      calls += 1;
      return { kind: "PROMPT_SENT", externalRef: params.externalRef };
    });

    const first = await initiateCollection(prisma, countingService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000036",
      channel: "MTN",
    });

    const second = await initiateCollection(prisma, countingService, {
      rideId: ride.id,
      riderId: rider.id,
      amountPesewas: 1000,
      payerPhone: "+233200000036",
      channel: "MTN",
    });

    expect(second.id).toBe(first.id);
    expect(calls).toBe(1);
  });
});
