import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../db/prisma";
import { driverBalances } from "../services/admin/cash";
import { driverPhotoPublicId } from "../services/uploads/cloudinarySignature";
import { uniqueGhanaPhone } from "../test/testPhone";
import {
  applyReset,
  CONFIRM_WORD,
  endpointId,
  parseArgs,
  parseCloudinaryUrl,
  planReset,
  type ResetOptions,
} from "./resetTestData";

// Everything here is dated 2001, and the cutoff is mid-2001: rows the rest of
// the suite leaves in the test database are dated now, so they count as
// "after the cutoff" and are never touched by these resets.
const OLD = new Date("2001-01-10T10:00:00Z");
const CUTOFF = new Date("2001-06-01T00:00:00Z");
const LATER = new Date("2001-09-01T10:00:00Z");
const CLOUD = "reset-test-cloud";
const photo = (cloud: string, userId: string) => `https://res.cloudinary.com/${cloud}/image/upload/v1700000000/${driverPhotoPublicId(userId)}.jpg`;

describe("parseArgs", () => {
  const now = new Date("2026-11-20T00:00:00Z");

  it("is a dry run unless confirmed with the exact word", () => {
    const dry = parseArgs(["--before=2026-11-16T00:00:00Z"], now);
    expect(dry.confirm).toBe(false);
    expect(dry.options).toEqual({ before: new Date("2026-11-16T00:00:00Z"), keepPhones: [] });
    expect(parseArgs(["--before=2026-11-16T00:00:00Z", `--confirm=${CONFIRM_WORD}`], now).confirm).toBe(true);
    expect(() => parseArgs(["--before=2026-11-16T00:00:00Z", "--confirm=yes"], now)).toThrow(/exactly/);
  });

  it("refuses a missing, malformed or future cutoff, unknown arguments and non-canonical keep numbers", () => {
    expect(() => parseArgs([], now)).toThrow(/required/);
    expect(() => parseArgs(["--before=16/11/2026"], now)).toThrow(/ISO/);
    expect(() => parseArgs(["--before=2027-01-01T00:00:00Z"], now)).toThrow(/future/);
    expect(() => parseArgs(["--before=2026-11-16T00:00:00Z", "--befor=x"], now)).toThrow(/Unknown/);
    expect(() => parseArgs(["--before=2026-11-16T00:00:00Z", "--keep=0241234567"], now)).toThrow(/canonical/);
    // The number is never printed in full.
    expect(() => parseArgs(["--before=2026-11-16T00:00:00Z", "--keep=0241234567"], now)).not.toThrow(/0241234567/);
    expect(parseArgs(["--before=2026-11-16T00:00:00Z", "--keep=+233241234567,+233541234567"], now).options.keepPhones).toEqual([
      "+233241234567",
      "+233541234567",
    ]);
  });
});

describe("parseCloudinaryUrl and endpointId", () => {
  it("finds the account and public id in an image link", () => {
    expect(parseCloudinaryUrl("https://res.cloudinary.com/acme/image/upload/v17/campusride/drivers/driver_u1.jpg")).toEqual({
      cloudName: "acme",
      publicId: "campusride/drivers/driver_u1",
    });
    expect(parseCloudinaryUrl("https://res.cloudinary.com/acme/image/upload/c_fill,w_400/old_upload.png")).toEqual({
      cloudName: "acme",
      publicId: "old_upload",
    });
    expect(parseCloudinaryUrl("https://example.com/photo.jpg")).toBeNull();
    expect(parseCloudinaryUrl("not a url")).toBeNull();
  });

  it("names the Neon endpoint without the pooler suffix", () => {
    expect(endpointId("ep-empty-violet-bay5yr3y-pooler.eu-central-1.aws.neon.tech")).toBe("ep-empty-violet-bay5yr3y");
    expect(endpointId("localhost")).toBe("localhost");
  });
});

describe("reset to zero (local test database)", () => {
  let zoneA: string;
  let zoneB: string;
  const ids: Record<string, string> = {};
  const phones: Record<string, string> = {};
  const rides: Record<string, string> = {};
  let options: ResetOptions;

  async function user(key: string, data: { role: "RIDER" | "DRIVER" | "ADMIN"; createdAt?: Date; isReviewDemo?: boolean; photoUrl?: (id: string) => string }) {
    const phone = uniqueGhanaPhone();
    const u = await prisma.user.create({
      data: { phone, name: `Reset ${key}`, role: data.role, createdAt: data.createdAt ?? OLD, isReviewDemo: data.isReviewDemo ?? false },
    });
    if (data.role === "DRIVER") {
      await prisma.driver.create({ data: { userId: u.id, plate: `RT ${key}`, isApproved: true, photoUrl: data.photoUrl?.(u.id) ?? null } });
    }
    ids[key] = u.id;
    phones[key] = phone;
    return u.id;
  }

  async function ride(key: string, riderKey: string, driverKey: string | null, createdAt: Date, extra: { isReviewDemo?: boolean; passengers?: string[] } = {}) {
    const r = await prisma.ride.create({
      data: {
        riderId: ids[riderKey]!,
        driverId: driverKey ? ids[driverKey]! : null,
        type: "SHARED",
        status: driverKey ? "COMPLETED" : "REQUESTED",
        pickupZoneId: zoneA,
        dropoffZoneId: zoneB,
        createdAt,
        isReviewDemo: extra.isReviewDemo ?? false,
      },
    });
    for (const p of extra.passengers ?? [riderKey]) {
      await prisma.ridePassenger.create({ data: { rideId: r.id, riderId: ids[p]!, pickupZoneId: zoneA, dropoffZoneId: zoneB, createdAt } });
    }
    rides[key] = r.id;
    return r.id;
  }

  /** Every fixture row still in the database, by table. */
  async function snapshot() {
    const userIds = Object.values(ids);
    const rideIds = Object.values(rides);
    const byUser = { userId: { in: userIds } };
    const byDriver = { driverUserId: { in: userIds } };
    return {
      users: await prisma.user.count({ where: { id: { in: userIds } } }),
      drivers: await prisma.driver.count({ where: byUser }),
      rides: await prisma.ride.count({ where: { id: { in: rideIds } } }),
      passengers: await prisma.ridePassenger.count({ where: { rideId: { in: rideIds } } }),
      ratings: await prisma.rating.count({ where: { rideId: { in: rideIds } } }),
      offers: await prisma.rideOffer.count({ where: { rideId: { in: rideIds } } }),
      rejections: await prisma.rideRejection.count({ where: { rideId: { in: rideIds } } }),
      sos: await prisma.sosEvent.count({ where: { rideId: { in: rideIds } } }),
      links: await prisma.trackingLink.count({ where: { rideId: { in: rideIds } } }),
      ridePayments: await prisma.payment.count({ where: { rideId: { in: rideIds } } }),
      ledger: await prisma.commissionLedger.count({ where: byDriver }),
      cash: await prisma.driverCashPayment.count({ where: byDriver }),
      paystack: await prisma.driverPaystackPayment.count({ where: byDriver }),
      sessions: await prisma.driverOnlineSession.count({ where: byDriver }),
      trail: await prisma.driverLocationPoint.count({ where: byDriver }),
      refresh: await prisma.refreshToken.count({ where: byUser }),
      push: await prisma.pushToken.count({ where: byUser }),
      closed: await prisma.accountDeletion.count({ where: byUser }),
      otp: await prisma.otpCode.count({ where: { phone: { in: [...Object.values(phones), phones.stranger!] } } }),
    };
  }

  beforeAll(async () => {
    const zones = await prisma.zone.findMany({ take: 2, select: { id: true } });
    expect(zones).toHaveLength(2);
    [zoneA, zoneB] = [zones[0]!.id, zones[1]!.id];

    await user("admin", { role: "ADMIN" });
    await user("demoRider", { role: "RIDER", isReviewDemo: true });
    await user("demoDriver", { role: "DRIVER", isReviewDemo: true, photoUrl: (id) => photo(CLOUD, id) });
    await user("keepRider", { role: "RIDER" });
    await user("keepDriver", { role: "DRIVER" });
    await user("lateRider", { role: "RIDER", createdAt: LATER });
    await user("rider1", { role: "RIDER" });
    await user("rider2", { role: "RIDER" });
    await user("driver1", { role: "DRIVER", photoUrl: (id) => photo(CLOUD, id) });
    await user("driver2", { role: "DRIVER", photoUrl: (id) => photo("someone-elses-cloud", id) });
    await user("closed", { role: "DRIVER" });
    await prisma.accountDeletion.create({
      data: { userId: ids.closed!, purgeAfter: LATER, keptPhotoUrl: photo(CLOUD, ids.closed!) },
    });
    phones.stranger = uniqueGhanaPhone();

    // A shared trip: two doomed riders and a kept one, a doomed driver.
    const shared = await ride("shared", "rider1", "driver1", OLD, { passengers: ["rider1", "rider2", "keepRider"] });
    await prisma.commissionLedger.create({ data: { rideId: shared, driverUserId: ids.driver1!, amountPesewas: 315, createdAt: OLD } });
    await prisma.rating.create({ data: { rideId: shared, raterId: ids.rider1!, rateeId: ids.driver1!, stars: 5, createdAt: OLD } });
    await prisma.rideOffer.create({ data: { rideId: shared, driverUserId: ids.driver1!, offeredAt: OLD, outcome: "ACCEPTED" } });
    await prisma.rideRejection.create({ data: { rideId: shared, driverUserId: ids.driver2!, createdAt: OLD } });
    await prisma.sosEvent.create({ data: { rideId: shared, riderId: ids.rider2!, rideStatus: "IN_PROGRESS", createdAt: OLD } });
    await prisma.trackingLink.create({ data: { token: `reset-test-${shared}`, rideId: shared, riderId: ids.rider2!, createdAt: OLD } });
    await prisma.payment.create({ data: { rideId: shared, riderId: ids.rider1!, amount: 700, type: "COLLECTION", createdAt: OLD } });

    // A kept driver's test trip (with a doomed rider) and the money around it.
    const kept = await ride("keepDriverTrip", "rider2", "keepDriver", OLD);
    await prisma.commissionLedger.create({ data: { rideId: kept, driverUserId: ids.keepDriver!, amountPesewas: 105, createdAt: OLD } });
    const paid = await prisma.driverCashPayment.create({
      data: { driverUserId: ids.keepDriver!, amountPesewas: 105, method: "CASH", paidAt: OLD, recordedBy: ids.admin!, createdAt: OLD },
    });
    // Its reversal, recorded after the cutoff: it must go with what it reverses.
    await prisma.driverCashPayment.create({
      data: { driverUserId: ids.keepDriver!, amountPesewas: -105, method: "CASH", paidAt: LATER, recordedBy: ids.admin!, reversesId: paid.id, createdAt: LATER },
    });
    await prisma.driverCashPayment.create({
      data: { driverUserId: ids.keepDriver!, amountPesewas: 105, method: "CASH", paidAt: OLD, recordedBy: ids.admin!, createdAt: OLD },
    });
    const attempt = await prisma.driverPaystackPayment.create({
      data: {
        driverUserId: ids.driver1!,
        reference: `reset-test-${ids.driver1}`,
        channel: "mobile_money",
        owedPesewas: 315,
        feePesewas: 6,
        grossPesewas: 321,
        feeBps: 195,
        status: "SUCCESS",
        createdAt: OLD,
      },
    });
    await prisma.driverCashPayment.create({
      data: { driverUserId: ids.driver1!, amountPesewas: 315, method: "PAYSTACK", paidAt: OLD, recordedBy: "paystack", paystackPaymentId: attempt.id, createdAt: OLD },
    });

    // The admin's own test ride before the cutoff (the admin stays, the ride goes).
    await ride("adminTrip", "admin", "driver1", OLD);
    // After the cutoff: a late rider's request (kept), and one a doomed driver served (goes).
    await ride("lateSearch", "lateRider", null, LATER);
    await ride("lateWithDoomedDriver", "lateRider", "driver1", LATER);

    // The review demo's own trip and money: all kept.
    const demo = await ride("demoTrip", "demoRider", "demoDriver", OLD, { isReviewDemo: true });
    await prisma.commissionLedger.create({ data: { rideId: demo, driverUserId: ids.demoDriver!, amountPesewas: 105, createdAt: OLD } });
    await prisma.driverCashPayment.create({
      data: { driverUserId: ids.demoDriver!, amountPesewas: 50, method: "CASH", paidAt: OLD, recordedBy: ids.admin!, createdAt: OLD },
    });
    await prisma.driverOnlineSession.create({ data: { driverUserId: ids.demoDriver!, startedAt: OLD } });

    // Presence, sessions, push, login codes.
    await prisma.driverOnlineSession.create({ data: { driverUserId: ids.driver1!, startedAt: OLD } });
    await prisma.driverOnlineSession.create({ data: { driverUserId: ids.keepDriver!, startedAt: OLD } });
    await prisma.driverLocationPoint.create({ data: { driverUserId: ids.driver1!, latitude: 5.65, longitude: -0.18, recordedAt: OLD } });
    await prisma.refreshToken.create({ data: { userId: ids.rider1!, tokenHash: `reset-${ids.rider1}`, familyId: "f", expiresAt: LATER } });
    await prisma.refreshToken.create({ data: { userId: ids.admin!, tokenHash: `reset-${ids.admin}`, familyId: "f", expiresAt: LATER } });
    await prisma.pushToken.create({ data: { userId: ids.rider1!, token: `ExponentPushToken[reset-${ids.rider1}]`, app: "rider", platform: "ios" } });
    for (const key of ["rider1", "stranger", "admin", "keepRider"]) {
      await prisma.otpCode.create({ data: { phone: phones[key]!, codeHash: "x", purpose: "LOGIN", expiresAt: OLD, createdAt: OLD } });
    }

    options = {
      before: CUTOFF,
      keepPhones: [phones.keepRider!, phones.keepDriver!],
      // The demo rider is recognised by its flag, the demo driver also by number.
      demoPhones: [phones.demoDriver!],
      cloudName: CLOUD,
    };
  });

  afterAll(async () => {
    const userIds = Object.values(ids);
    const byDriver = { driverUserId: { in: userIds } };
    const rideIds = (await prisma.ride.findMany({ where: { OR: [{ riderId: { in: userIds } }, { driverId: { in: userIds } }] }, select: { id: true } })).map((r) => r.id);
    await prisma.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
    await prisma.commissionLedger.deleteMany({ where: byDriver });
    await prisma.driverCashPayment.deleteMany({ where: { ...byDriver, NOT: { reversesId: null } } });
    await prisma.driverCashPayment.deleteMany({ where: byDriver });
    await prisma.driverPaystackPayment.deleteMany({ where: byDriver });
    await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
    await prisma.otpCode.deleteMany({ where: { phone: { in: [...Object.values(phones)] } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actor: "script:resetTestData" } });
  });

  it("stops, changing nothing, when a review demo ride involves an account it would delete", async () => {
    const tangled = await ride("tangled", "demoRider", "demoDriver", OLD, { isReviewDemo: true, passengers: ["demoRider", "rider1"] });
    const before = await snapshot();
    await expect(applyReset(prisma, options, async () => ({ ok: true }))).rejects.toThrow(/review demo ride/);
    expect(await snapshot()).toEqual(before);
    await prisma.ridePassenger.deleteMany({ where: { rideId: tangled } });
    await prisma.ride.delete({ where: { id: tangled } });
    delete rides.tangled;
  });

  it("dry run: counts what would go and lists who stays, deleting nothing", async () => {
    const before = await snapshot();
    const plan = await planReset(prisma, options);
    expect(await snapshot()).toEqual(before);

    const count = (label: string) => plan.counts.find((c) => c.label.trim() === label)?.rows;
    expect(count("Accounts (riders and drivers)")).toBe(5); // rider1, rider2, driver1, driver2, closed
    expect(count("Rides")).toBe(4); // shared, keepDriverTrip, adminTrip, lateWithDoomedDriver
    expect(count("seats (ride passengers)")).toBe(6);
    expect(count("Finances: commission owed (ledger)")).toBe(2);
    expect(count("payments, waivers, adjustments")).toBe(4);
    expect(count("Paystack payment attempts")).toBe(1);
    expect(count("login codes (app)")).toBe(2); // rider1's and the stranger's, not the admin's or the kept rider's

    const kept = new Map(plan.kept.map((k) => [k.phone, k.why]));
    expect(kept.get(phones.admin!)).toBe("admin");
    expect(kept.get(phones.demoRider!)).toBe("review demo");
    expect(kept.get(phones.demoDriver!)).toBe("review demo");
    expect(kept.get(phones.keepRider!)).toBe("--keep");
    expect(kept.get(phones.keepDriver!)).toBe("--keep");
    expect(kept.get(phones.lateRider!)).toBe("created after the cutoff");
    for (const gone of ["rider1", "rider2", "driver1", "driver2", "closed"]) expect(kept.has(phones[gone]!)).toBe(false);

    // Photos: driver1's and the closed account's, in our Cloudinary account; driver2's is in another, so it's only listed.
    expect(new Set(plan.photos.map((p) => p.userId))).toEqual(new Set([ids.driver1, ids.closed]));
    expect(plan.photos.every((p) => !p.publicId.includes("demo"))).toBe(true);
    expect(plan.photoProblems).toEqual([expect.objectContaining({ phone: phones.driver2, what: expect.stringContaining("someone-elses-cloud") })]);
  });

  it("real run: deletes the rest in one go, keeps the protected, leaves no orphans and Finances at zero", async () => {
    const destroyed: string[] = [];
    const result = await applyReset(prisma, options, async (publicId) => {
      destroyed.push(publicId);
      // One failure: listed, not fatal.
      return publicId.includes(ids.closed!) ? { ok: false, reason: "HTTP 500" } : { ok: true };
    });
    // One image per deleted driver photo: the link's public id is the standard one, so no duplicates.
    expect(new Set(destroyed)).toEqual(new Set([driverPhotoPublicId(ids.driver1!), driverPhotoPublicId(ids.closed!)]));
    expect(destroyed).toHaveLength(2);
    expect(result.photoFailures).toEqual([{ phone: phones.closed, what: expect.stringContaining("HTTP 500") }]);

    const survivors = await prisma.user.findMany({ where: { id: { in: Object.values(ids) } }, select: { id: true } });
    expect(new Set(survivors.map((s) => s.id))).toEqual(
      new Set([ids.admin, ids.demoRider, ids.demoDriver, ids.keepRider, ids.keepDriver, ids.lateRider]),
    );
    expect(await prisma.driver.count({ where: { userId: { in: [ids.demoDriver!, ids.keepDriver!] } } })).toBe(2);

    // Rides: only the demo trip and the late rider's own request remain.
    const left = await prisma.ride.findMany({ where: { id: { in: Object.values(rides) } }, select: { id: true } });
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([rides.demoTrip, rides.lateSearch]));

    // No row anywhere still points at a deleted account.
    const gone = ["rider1", "rider2", "driver1", "driver2", "closed"].map((k) => ids[k]!);
    const G = { in: gone };
    const orphans = await Promise.all([
      prisma.ride.count({ where: { OR: [{ riderId: G }, { driverId: G }] } }),
      prisma.ridePassenger.count({ where: { riderId: G } }),
      prisma.rating.count({ where: { OR: [{ raterId: G }, { rateeId: G }] } }),
      prisma.payment.count({ where: { riderId: G } }),
      prisma.commissionLedger.count({ where: { driverUserId: G } }),
      prisma.driverCashPayment.count({ where: { driverUserId: G } }),
      prisma.driverPaystackPayment.count({ where: { driverUserId: G } }),
      prisma.driverOnlineSession.count({ where: { driverUserId: G } }),
      prisma.driverLocationPoint.count({ where: { driverUserId: G } }),
      prisma.rideOffer.count({ where: { driverUserId: G } }),
      prisma.rideRejection.count({ where: { driverUserId: G } }),
      prisma.sosEvent.count({ where: { riderId: G } }),
      prisma.trackingLink.count({ where: { riderId: G } }),
      prisma.refreshToken.count({ where: { userId: G } }),
      prisma.pushToken.count({ where: { userId: G } }),
      prisma.accountDeletion.count({ where: { userId: G } }),
      prisma.otpCode.count({ where: { phone: { in: [phones.rider1!, phones.stranger!] } } }),
    ]);
    expect(orphans.every((n) => n === 0)).toBe(true);

    // Finances: nothing from before the cutoff outside the demo; the kept driver owes and has paid nothing.
    const notDemo = { driverUserId: { notIn: [ids.demoDriver!] }, createdAt: { lt: CUTOFF } };
    expect(await prisma.commissionLedger.count({ where: notDemo })).toBe(0);
    expect(await prisma.driverCashPayment.count({ where: notDemo })).toBe(0);
    expect(await prisma.driverPaystackPayment.count({ where: notDemo })).toBe(0);
    const balances = await driverBalances(prisma, [ids.keepDriver!, ids.driver1!]);
    expect([...balances.values()].every((b) => b.owedPesewas === 0 && b.paidPesewas === 0 && b.balancePesewas === 0)).toBe(true);
    // The demo's money is untouched.
    expect((await driverBalances(prisma, [ids.demoDriver!])).get(ids.demoDriver!)).toMatchObject({ owedPesewas: 105, paidPesewas: 50 });
    expect(await prisma.driverOnlineSession.count({ where: { driverUserId: ids.demoDriver! } })).toBe(1);
    expect(await prisma.driverOnlineSession.count({ where: { driverUserId: ids.keepDriver! } })).toBe(0);

    // Kept people keep their sessions and login codes; the reset is in the audit log.
    expect(await prisma.refreshToken.count({ where: { userId: ids.admin! } })).toBe(1);
    expect(await prisma.otpCode.count({ where: { phone: { in: [phones.admin!, phones.keepRider!] } } })).toBe(2);
    const audit = await prisma.adminAuditLog.findFirst({ where: { actor: "script:resetTestData" }, orderBy: { timestamp: "desc" } });
    expect(audit?.reason).toContain("2001-06-01T00:00:00.000Z");
    expect(audit?.reason).toContain("5 accounts (riders and drivers)");

    // Running it again finds nothing left to delete.
    const again = await planReset(prisma, options);
    expect(again.counts.every((c) => c.rows === 0)).toBe(true);
  });
});
