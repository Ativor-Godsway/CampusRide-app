/**
 * Drivers' commission balance, paying it through Paystack, blocking going
 * online at the limit, and the admin's mark-as-paid / waive / waive-all.
 * Paystack is a fake here (FakePaystack): nothing leaves the machine. The
 * webhook is signed with a test secret exactly as Paystack signs it.
 */
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { User } from "@prisma/client";
import { paystackQuote, type MomoNetwork } from "@rida/shared";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAllRoutes } from "./index";
import { DummyOtpService } from "../services/otp/DummyOtpService";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken } from "../services/auth/tokens";
import { getTestZones } from "../services/ride/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { clearAdminCache } from "../services/admin/cache";
import { resetPaymentChecksForTests } from "../services/commission/payments";
import type { ChargeAnswer, PaystackClient, VerifyAnswer } from "../services/commission/paystack";

const SECRET = "sk_test_commission_payments_suite";

/** Paystack, in memory: charges wait until the test "pays" them. */
class FakePaystack implements PaystackClient {
  configured = true;
  /** reference → what Paystack would say on verify. */
  txns = new Map<string, { amountPesewas: number; currency: string; status: string; reference: string }>();
  /** The next charge's answer, instead of "pay_offline". */
  nextCharge: ChargeAnswer | null = null;
  phones: string[] = [];
  verifyCalls = 0;

  async chargeMomo(input: { reference: string; amountPesewas: number; email: string; phone: string; network: MomoNetwork }): Promise<ChargeAnswer> {
    this.phones.push(input.phone);
    const answer = this.nextCharge ?? { kind: "answered", status: "pay_offline", message: "Approve the payment on your phone." };
    this.nextCharge = null;
    if (answer.kind !== "refused") {
      this.txns.set(input.reference, { amountPesewas: input.amountPesewas, currency: "GHS", status: answer.kind === "answered" ? answer.status : "pending", reference: input.reference });
    }
    return answer;
  }
  async submitOtp(reference: string): Promise<ChargeAnswer> {
    return this.txns.has(reference) ? { kind: "answered", status: "pay_offline", message: "Approve on your phone." } : { kind: "refused", message: "Unknown" };
  }
  async initializeCheckout(input: { reference: string; amountPesewas: number }) {
    this.txns.set(input.reference, { amountPesewas: input.amountPesewas, currency: "GHS", status: "abandoned", reference: input.reference });
    return { kind: "created" as const, url: `https://checkout.paystack.com/${input.reference}` };
  }
  async verify(reference: string): Promise<VerifyAnswer> {
    this.verifyCalls += 1;
    const t = this.txns.get(reference);
    if (!t) return { kind: "not_found" };
    return { kind: "found", status: t.status, reference: t.reference, amountPesewas: t.amountPesewas, currency: t.currency, feesPesewas: 150, paidAt: new Date(), message: null };
  }
  /** The driver approved: Paystack now says success (optionally with other numbers). */
  pay(reference: string, over: Partial<{ amountPesewas: number; currency: string; reference: string }> = {}) {
    const t = this.txns.get(reference)!;
    this.txns.set(reference, { ...t, status: "success", ...over });
  }
}

let app: FastifyInstance;
const paystack = new FakePaystack();
const userIds: string[] = [];
const rideIds: string[] = [];
let admin: User;
let zones: { pickup: { id: string }; dropoff: { id: string } };

const auth = (u: User) => ({ authorization: `Bearer ${signAccessToken({ userId: u.id, role: u.role })}` });
const get = (url: string, as: User) => app.inject({ method: "GET", url, headers: auth(as) });
const post = (url: string, payload: object, as: User) => app.inject({ method: "POST", url, headers: auth(as), payload });
const put = (url: string, payload: object, as: User) => app.inject({ method: "PUT", url, headers: auth(as), payload });

function sign(body: string, secret = SECRET) {
  return createHmac("sha512", secret).update(body).digest("hex");
}
function webhook(reference: string, signature?: string) {
  const body = JSON.stringify({ event: "charge.success", data: { reference, amount: 1, currency: "GHS" } });
  return app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: { "content-type": "application/json", "x-paystack-signature": signature ?? sign(body) },
    payload: body,
  });
}

async function user(role: "RIDER" | "DRIVER" | "ADMIN", name: string) {
  const u = await prisma.user.create({ data: { phone: uniqueGhanaPhone(), name, role } });
  userIds.push(u.id);
  return u;
}

async function driver(name: string) {
  const u = await user("DRIVER", name);
  await prisma.driver.create({
    data: { userId: u.id, carMake: "Toyota", carModel: "Vitz", carColor: "Green", plate: `GT ${Math.floor(Math.random() * 9000) + 1000}-30`, isApproved: true },
  });
  return u;
}

/** A completed cash trip whose 15% the driver owes (`commission` pesewas). */
async function trip(d: User, commission: number, status: "COMPLETED" | "IN_PROGRESS" = "COMPLETED") {
  const rider = await user("RIDER", "Ama Rider");
  const ride = await prisma.ride.create({
    data: {
      riderId: rider.id,
      driverId: d.id,
      pickupZoneId: zones.pickup.id,
      dropoffZoneId: zones.dropoff.id,
      type: "LONE",
      status,
      completedAt: status === "COMPLETED" ? new Date() : null,
      passengers: { create: [{ riderId: rider.id, pickupZoneId: zones.pickup.id, dropoffZoneId: zones.dropoff.id, status: status === "COMPLETED" ? "DROPPED_OFF" : "PICKED_UP", lockedFare: commission * 7 }] },
    } as never,
  });
  rideIds.push(ride.id);
  if (status === "COMPLETED") await prisma.commissionLedger.create({ data: { driverUserId: d.id, rideId: ride.id, amountPesewas: commission } });
  return ride;
}

async function balance(d: User) {
  const res = await get("/driver/balance", d);
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function setRules(rules: Partial<{ debtLimitPesewas: number; warningPercent: number; enforcementEnabled: boolean; feeBps: number; feeCapPesewas: number | null }>) {
  const res = await put(
    "/admin/commission-settings",
    { debtLimitPesewas: 10_000, warningPercent: 80, enforcementEnabled: false, feeBps: 195, feeCapPesewas: null, ...rules },
    admin,
  );
  expect(res.statusCode).toBe(200);
}

const goOnline = (d: User) => app.inject({ method: "PATCH", url: "/driver/availability", headers: auth(d), payload: { isOnline: true } });
const goOffline = (d: User) => app.inject({ method: "PATCH", url: "/driver/availability", headers: auth(d), payload: { isOnline: false } });

async function payMomo(d: User, network: MomoNetwork = "MTN") {
  const res = await post("/driver/balance/payments", { channel: "MOMO", phone: "024 123 4567", network }, d);
  expect(res.statusCode).toBe(201);
  return res.json().payment as { reference: string; status: string; owedPesewas: number; grossPesewas: number; feePesewas: number; needsOtp: boolean; checkoutUrl: string | null; message: string | null; phoneLast4: string | null };
}

beforeAll(async () => {
  (config.paystack as { secretKey: string }).secretKey = SECRET;
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService: new DummyOtpService(), paymentService: new DummyPaymentService(), paystack });
  await app.ready();
  zones = await getTestZones();
  admin = await user("ADMIN", "Finance Admin");
});

beforeEach(async () => {
  resetPaymentChecksForTests();
  clearAdminCache();
  await prisma.commissionSetting.deleteMany({});
});

afterAll(async () => {
  await prisma.commissionSetting.deleteMany({});
  // "Waive all" reached every driver in the test database, not only these.
  await prisma.driverCashPayment.deleteMany({ where: { recordedBy: { in: userIds }, reversesId: { not: null } } });
  await prisma.driverCashPayment.deleteMany({ where: { recordedBy: { in: userIds } } });
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds }, reversesId: { not: null } } });
  await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.driverPaystackPayment.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
  await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { actor: { in: userIds } } });
  await prisma.driverOnlineSession.deleteMany({ where: { driverUserId: { in: userIds } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe("the balance", () => {
  it("is commissions − payments − waivers, with the history newest first", async () => {
    const d = await driver("Kwame Balance");
    await trip(d, 300);
    await trip(d, 450);
    expect((await post("/admin/cash/payments", { driverId: d.id, amountPesewas: 200, method: "CASH", note: "Paid at the office" }, admin)).statusCode).toBe(201);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 100, reason: "Launch week" }, admin)).statusCode).toBe(201);

    const b = await balance(d);
    expect(b.commissionPesewas).toBe(750);
    expect(b.paidPesewas).toBe(200);
    expect(b.waivedPesewas).toBe(100);
    expect(b.balancePesewas).toBe(450);
    expect(b.history.map((e: { kind: string }) => e.kind).sort()).toEqual(["COMMISSION", "COMMISSION", "PAYMENT", "WAIVER"]);
    expect(b.history.find((e: { kind: string }) => e.kind === "PAYMENT").effectPesewas).toBe(-200);
    // The driver never sees admin notes or who recorded a row.
    expect(b.history.every((e: object) => !("note" in e) && !("recordedBy" in e))).toBe(true);
    // Defaults: GH₵100, 80%, enforcement off, so no warning and no block.
    expect(b.rules).toMatchObject({ debtLimitPesewas: 10_000, warningPesewas: 8_000, enforcementEnabled: false });
    expect(b.warning).toBeNull();
    expect(b.blocked).toBe(false);
  });

  it("quotes the fee so CampusRide receives the whole balance, with and without a cap", async () => {
    const d = await driver("Akua Quote");
    await trip(d, 8_500);
    await setRules({ feeBps: 195 });
    expect((await balance(d)).quote).toEqual(paystackQuote(8_500, 195, null));
    await setRules({ feeBps: 195, feeCapPesewas: 100 });
    expect((await balance(d)).quote).toEqual({ owedPesewas: 8_500, feePesewas: 100, grossPesewas: 8_600 });
  });

  it("is only for drivers", async () => {
    const rider = await user("RIDER", "Not A Driver");
    expect((await get("/driver/balance", rider)).statusCode).toBe(403);
  });
});

describe("going online at the limit", () => {
  it("is blocked only with enforcement on and the balance at the limit", async () => {
    const d = await driver("Yaw Limit");
    await trip(d, 10_000);

    // Enforcement off (the launch default): commission piles up, never blocked.
    expect((await goOnline(d)).statusCode).toBe(200);
    expect((await goOffline(d)).statusCode).toBe(200);

    await setRules({ enforcementEnabled: true, debtLimitPesewas: 10_000 });
    const refused = await goOnline(d);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "COMMISSION_LIMIT", owedPesewas: 10_000, limitPesewas: 10_000 });
    expect(refused.json().error).toContain("GH₵100");
    expect((await balance(d)).blocked).toBe(true);

    // Just under the limit: allowed, with the warning.
    await setRules({ enforcementEnabled: true, debtLimitPesewas: 10_001 });
    expect((await goOnline(d)).statusCode).toBe(200);
    expect((await balance(d)).warning).toBe("You owe GH₵100. Pay before GH₵100.01 to keep driving.");
  });

  it("never stops a driver who is already online or on a trip", async () => {
    const online = await driver("Esi AlreadyOnline");
    await trip(online, 20_000);
    expect((await goOnline(online)).statusCode).toBe(200);
    await setRules({ enforcementEnabled: true });
    // The app sending "online" again while online is not going online.
    expect((await goOnline(online)).statusCode).toBe(200);
    // Going offline always works.
    expect((await goOffline(online)).statusCode).toBe(200);
    expect((await goOnline(online)).statusCode).toBe(403);

    const busy = await driver("Kofi MidTrip");
    await trip(busy, 20_000);
    await trip(busy, 0, "IN_PROGRESS");
    expect((await goOnline(busy)).statusCode).toBe(200);
  });
});

describe("paying with Paystack", () => {
  it("credits the locked amount once Paystack confirms, and the webhook only once", async () => {
    const d = await driver("Ama Pays");
    await trip(d, 8_500);
    await setRules({ feeBps: 195 });
    const payment = await payMomo(d);
    expect(payment).toMatchObject({ status: "PENDING", owedPesewas: 8_500, grossPesewas: 8_670, feePesewas: 170, phoneLast4: "4567", needsOtp: false });
    expect(payment.message).toBe("Approve the payment on your phone.");
    // Paystack gets the local number; we keep the last 4 digits only.
    expect(paystack.phones.at(-1)).toBe("0241234567");
    const stored = await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { reference: payment.reference } });
    expect(JSON.stringify(stored)).not.toContain("0241234567");

    // Not paid yet: a webhook (forged or early) changes nothing.
    expect((await webhook(payment.reference)).statusCode).toBe(200);
    expect((await balance(d)).balancePesewas).toBe(8_500);

    paystack.pay(payment.reference);
    expect((await webhook(payment.reference)).statusCode).toBe(200);
    expect((await webhook(payment.reference)).statusCode).toBe(200);
    const after = await balance(d);
    expect(after.balancePesewas).toBe(0);
    expect(after.paidPesewas).toBe(8_500);
    expect(await prisma.driverCashPayment.count({ where: { driverUserId: d.id, method: "PAYSTACK" } })).toBe(1);

    const status = await get(`/driver/balance/payments/${payment.reference}`, d);
    expect(status.json().payment).toMatchObject({ status: "SUCCESS" });
    const row = await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { reference: payment.reference } });
    expect(row.paystackFeePesewas).toBe(150);
  });

  it("refuses a webhook with a bad or missing signature", async () => {
    const d = await driver("Kojo Forged");
    await trip(d, 5_000);
    const payment = await payMomo(d);
    paystack.pay(payment.reference);
    expect((await webhook(payment.reference, sign("something else"))).statusCode).toBe(401);
    expect((await webhook(payment.reference, "nope")).statusCode).toBe(401);
    const body = JSON.stringify({ event: "charge.success", data: { reference: payment.reference } });
    expect((await webhook(payment.reference, sign(body, "sk_test_wrong_key"))).statusCode).toBe(401);
    expect((await balance(d)).balancePesewas).toBe(5_000);
  });

  it("never credits a payment whose amount, currency or reference doesn't match", async () => {
    const d = await driver("Efua Mismatch");
    await trip(d, 6_000);
    const payment = await payMomo(d);
    paystack.pay(payment.reference, { amountPesewas: 100 });
    expect((await webhook(payment.reference)).statusCode).toBe(200);
    expect((await balance(d)).balancePesewas).toBe(6_000);
    expect((await get(`/driver/balance/payments/${payment.reference}`, d)).json().payment.status).toBe("MISMATCH");

    const other = await driver("Adwoa Currency");
    await trip(other, 6_000);
    const p2 = await payMomo(other);
    paystack.pay(p2.reference, { currency: "NGN" });
    await webhook(p2.reference);
    expect((await balance(other)).balancePesewas).toBe(6_000);
  });

  it("clears only the locked amount when commission arrives during the payment", async () => {
    const d = await driver("Yaa DuringPayment");
    await trip(d, 4_000);
    const payment = await payMomo(d);
    expect(payment.owedPesewas).toBe(4_000);
    // A trip ends while the driver is approving on their phone.
    await trip(d, 1_500);
    paystack.pay(payment.reference);
    // The app's status check confirms it too (the webhook may be late).
    const status = await get(`/driver/balance/payments/${payment.reference}`, d);
    expect(status.json().payment.status).toBe("SUCCESS");
    expect((await balance(d)).balancePesewas).toBe(1_500);
  });

  it("asks for the code a network wants, then waits for approval", async () => {
    const d = await driver("Nana Telecel");
    await trip(d, 3_000);
    paystack.nextCharge = { kind: "answered", status: "send_otp", message: "Dial *110# to get a voucher code, then enter it." };
    const payment = await payMomo(d, "TELECEL");
    expect(payment.needsOtp).toBe(true);
    expect(payment.message).toContain("*110#");
    const sent = await post(`/driver/balance/payments/${payment.reference}/otp`, { otp: "123456" }, d);
    expect(sent.statusCode).toBe(200);
    expect(sent.json().payment).toMatchObject({ status: "PENDING", needsOtp: false });
    expect((await post(`/driver/balance/payments/${payment.reference}/otp`, { otp: "123456" }, d)).statusCode).toBe(409);
  });

  it("falls back to Paystack's checkout page when the charge is refused", async () => {
    const d = await driver("Kweku Fallback");
    await trip(d, 2_000);
    paystack.nextCharge = { kind: "refused", message: "Charge not available for this account" };
    const payment = await payMomo(d);
    expect(payment.status).toBe("PENDING");
    expect(payment.checkoutUrl).toMatch(/^https:\/\/checkout\.paystack\.com\//);
    paystack.pay(payment.reference);
    await webhook(payment.reference);
    expect((await balance(d)).balancePesewas).toBe(0);
  });

  it("says why a charge failed", async () => {
    const d = await driver("Abena Declined");
    await trip(d, 2_000);
    paystack.nextCharge = { kind: "answered", status: "failed", message: "Insufficient funds" };
    const payment = await payMomo(d);
    expect(payment).toMatchObject({ status: "FAILED", message: "Insufficient funds" });
    expect((await balance(d)).balancePesewas).toBe(2_000);
  });

  it("returns the same payment on a double tap, and replaces an older unfinished one", async () => {
    const d = await driver("Kwabena DoubleTap");
    await trip(d, 2_500);
    const first = await payMomo(d);
    const again = await payMomo(d);
    expect(again.reference).toBe(first.reference);
    await prisma.driverPaystackPayment.update({ where: { reference: first.reference }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const third = await payMomo(d);
    expect(third.reference).not.toBe(first.reference);
    expect((await prisma.driverPaystackPayment.findUniqueOrThrow({ where: { reference: first.reference } })).status).toBe("ABANDONED");
  });

  it("refuses when nothing is owed, for another driver's payment, and without details", async () => {
    const d = await driver("Akos Nothing");
    const none = await post("/driver/balance/payments", { channel: "MOMO", phone: "0241234567", network: "MTN" }, d);
    expect(none.statusCode).toBe(409);
    expect(none.json().code).toBe("NOTHING_OWED");

    const owner = await driver("Owner Driver");
    await trip(owner, 2_000);
    const payment = await payMomo(owner);
    expect((await get(`/driver/balance/payments/${payment.reference}`, d)).statusCode).toBe(404);
    expect((await post("/driver/balance/payments", { channel: "MOMO" }, owner)).statusCode).toBe(400);
    expect((await post("/driver/balance/payments", { channel: "MOMO", phone: "12", network: "MTN" }, owner)).json().code).toBe("INVALID_PHONE");
  });

  it("is unavailable without a Paystack key", async () => {
    const d = await driver("Ekow NoKey");
    await trip(d, 2_000);
    paystack.configured = false;
    try {
      const res = await post("/driver/balance/payments", { channel: "CHECKOUT" }, d);
      expect(res.statusCode).toBe(503);
      expect((await balance(d)).canPay).toBe(false);
    } finally {
      paystack.configured = true;
    }
  });
});

describe("admin: mark as paid, waive, waive all, settings", () => {
  it("marks cash paid in person and waives with a reason, each logged with the admin", async () => {
    const d = await driver("Kofi Admin");
    await trip(d, 5_000);
    expect((await post("/admin/cash/payments", { driverId: d.id, amountPesewas: 3_000, method: "CASH", note: "Paid to me at the hostel" }, admin)).statusCode).toBe(201);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 9_000, reason: "Too much" }, admin)).statusCode).toBe(400);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 2_000, reason: "  " }, admin)).statusCode).toBe(400);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 2_000, reason: "Fuel shortage week" }, admin)).statusCode).toBe(201);
    expect((await balance(d)).balancePesewas).toBe(0);

    const ledger = (await get(`/admin/drivers/${d.id}/ledger`, admin)).json().entries;
    const waiver = ledger.find((e: { kind: string }) => e.kind === "WAIVER");
    expect(waiver).toMatchObject({ note: "Fuel shortage week", recordedBy: "Finance Admin", effectPesewas: -2_000 });
    const audit = await prisma.adminAuditLog.findMany({ where: { actor: admin.id, action: { in: ["cash.payment.record", "cash.waive"] } } });
    expect(audit.some((a) => a.action === "cash.waive" && a.reason?.includes("Fuel shortage week"))).toBe(true);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 100, reason: "Again" }, admin)).statusCode).toBe(409);
    expect((await post(`/admin/drivers/${d.id}/waive`, { amountPesewas: 100, reason: "Again" }, d)).statusCode).toBe(403);
  });

  it("waives every balance at once, and later commission stays owed", async () => {
    const a = await driver("Waive All A");
    const b = await driver("Waive All B");
    await trip(a, 1_234);
    await trip(b, 5_678);
    expect((await post("/admin/cash/waive-all", { reason: "" }, admin)).statusCode).toBe(400);
    const res = await post("/admin/cash/waive-all", { reason: "Commission-free launch period" }, admin);
    expect(res.statusCode).toBe(201);
    expect(res.json().drivers).toBeGreaterThanOrEqual(2);
    expect((await balance(a)).balancePesewas).toBe(0);
    expect((await balance(b)).balancePesewas).toBe(0);
    await trip(a, 300);
    expect((await balance(a)).balancePesewas).toBe(300);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "cash.waive.all" } })).toBeGreaterThanOrEqual(1);

    const waivers = (await get("/admin/cash/payments?kind=WAIVER&pageSize=500", admin)).json().payments;
    expect(waivers.some((w: { driver: { id: string }; note: string }) => w.driver.id === a.id && w.note === "Commission-free launch period")).toBe(true);
  });

  it("shows the period's totals on Finances", async () => {
    const d = await driver("Totals Driver");
    await trip(d, 8_500);
    await setRules({ feeBps: 195 });
    const payment = await payMomo(d);
    paystack.pay(payment.reference);
    await webhook(payment.reference);
    const from = new Date(Date.now() - 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 60 * 60_000).toISOString();
    clearAdminCache();
    const cash = (await get(`/admin/cash?from=${from}&to=${to}`, admin)).json();
    expect(cash.collectedPaystackPesewas).toBeGreaterThanOrEqual(8_500);
    expect(cash.paystackFeesPaidByDriversPesewas).toBeGreaterThanOrEqual(170);
    const payments = (await get(`/admin/cash/payments?kind=PAYMENT&driverId=${d.id}`, admin)).json().payments;
    expect(payments[0]).toMatchObject({ method: "PAYSTACK", recordedBy: { name: "Paystack" }, paystack: { reference: payment.reference } });
  });

  it("saves the rules with bounds, and logs who changed them", async () => {
    expect((await get("/admin/commission-settings", admin)).json().settings).toMatchObject({ debtLimitPesewas: 10_000, warningPercent: 80, enforcementEnabled: false });
    const bad = await put("/admin/commission-settings", { debtLimitPesewas: 10_000, warningPercent: 150, enforcementEnabled: true, feeBps: 0, feeCapPesewas: null }, admin);
    expect(bad.statusCode).toBe(400);
    await setRules({ enforcementEnabled: true, debtLimitPesewas: 5_000, feeCapPesewas: 1_000 });
    const saved = (await get("/admin/commission-settings", admin)).json();
    expect(saved.settings).toMatchObject({ enforcementEnabled: true, debtLimitPesewas: 5_000, feeCapPesewas: 1_000, updatedBy: { name: "Finance Admin" } });
    expect(saved.paystackConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(await prisma.adminAuditLog.count({ where: { actor: admin.id, action: "commission.settings" } })).toBeGreaterThanOrEqual(1);
  });
});
