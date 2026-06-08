import { describe, it, expect } from "vitest";
import { DummyPaymentService } from "./DummyPaymentService";
import { TX_STATUS } from "./constants";

describe("DummyPaymentService — happy paths (no network)", () => {
  it("collect returns PENDING, matching Moolre's real async collection flow", async () => {
    const service = new DummyPaymentService();
    const result = await service.collect({
      rideId: "ride-1",
      payerPhone: "+233200000001",
      channel: "MTN",
      amountPesewas: 1000,
      externalRef: "collect:ride-1:rider-1",
    });
    expect(result.txstatus).toBe(TX_STATUS.PENDING);
    expect(result.externalRef).toBe("collect:ride-1:rider-1");
  });

  it("validateRecipient resolves an account name", async () => {
    const service = new DummyPaymentService();
    const result = await service.validateRecipient({ phone: "+233200000002", channel: "MTN" });
    expect(result.accountName).toContain("+233200000002");
  });

  it("disburse succeeds immediately", async () => {
    const service = new DummyPaymentService();
    const result = await service.disburse({
      rideId: "ride-1",
      recipientPhone: "+233200000003",
      channel: "MTN",
      amountPesewas: 850,
      externalRef: "disburse:ride-1:driver-1",
    });
    expect(result.txstatus).toBe(TX_STATUS.SUCCESS);
  });

  it("getStatus returns UNKNOWN for an externalRef never seen", async () => {
    const service = new DummyPaymentService();
    const result = await service.getStatus("never-seen");
    expect(result.txstatus).toBe(TX_STATUS.UNKNOWN);
  });

  it("getStatus reflects the stored result after collect/disburse", async () => {
    const service = new DummyPaymentService();
    await service.collect({
      rideId: "ride-1",
      payerPhone: "+233200000001",
      channel: "MTN",
      amountPesewas: 1000,
      externalRef: "collect:ride-1:rider-1",
    });
    expect((await service.getStatus("collect:ride-1:rider-1")).txstatus).toBe(TX_STATUS.PENDING);

    service.markCollected("collect:ride-1:rider-1");
    expect((await service.getStatus("collect:ride-1:rider-1")).txstatus).toBe(TX_STATUS.SUCCESS);
  });

  it("idempotency: repeated collect with the same externalRef returns the stored result, not a fresh one", async () => {
    const service = new DummyPaymentService();
    const externalRef = "collect:ride-1:rider-1";
    await service.collect({
      rideId: "ride-1",
      payerPhone: "+233200000001",
      channel: "MTN",
      amountPesewas: 1000,
      externalRef,
    });
    service.markCollected(externalRef);

    // A retry after the provider already confirmed success must not reset to PENDING.
    const retry = await service.collect({
      rideId: "ride-1",
      payerPhone: "+233200000001",
      channel: "MTN",
      amountPesewas: 1000,
      externalRef,
    });
    expect(retry.txstatus).toBe(TX_STATUS.SUCCESS);
  });
});
