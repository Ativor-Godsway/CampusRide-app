import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { prisma } from "../../db/prisma";
import { splitFare, getLoneFare } from "@rida/shared";
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  DELETED_NAME_PLACEHOLDER,
  deleteAccount,
  deletedPhonePlaceholder,
  destroyDriverPhoto,
  purgeDeletedAccounts,
} from "./deleteAccount";
import { login, refresh, signup } from "./authService";
import { signVerificationToken } from "./tokens";
import { cleanupUser, uniqueTestPhone } from "./testFixtures";
import { createTestDriver, createTestRide, cleanupRide, cleanupDriver } from "../ride/testFixtures";
import { UserNotFoundError } from "./errors";

const userIds: string[] = [];
const rideIds: string[] = [];
const driverUserIds: string[] = [];

afterEach(async () => {
  while (rideIds.length > 0) await cleanupRide(rideIds.pop()!);
  while (driverUserIds.length > 0) await cleanupDriver(driverUserIds.pop()!);
  while (userIds.length > 0) await cleanupUser(userIds.pop()!);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function newRider() {
  const phone = uniqueTestPhone();
  const created = await signup(prisma, {
    phone,
    name: "Deletable Rider",
    role: "RIDER",
    verifiedToken: signVerificationToken({ phone, purpose: "SIGNUP" }),
  });
  userIds.push(created.user.id);
  return { ...created, phone };
}

describe("deleteAccount", () => {
  it("anonymizes name and phone and marks the account deleted", async () => {
    const { user } = await newRider();

    await deleteAccount(prisma, user.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.name).toBe(DELETED_NAME_PLACEHOLDER);
    expect(after.phone).toBe(deletedPhonePlaceholder(user.id));
    expect(after.deletedAt).toBeInstanceOf(Date);
  });

  it("revokes every refresh token so no session survives", async () => {
    const session = await newRider();
    // A second live session, as if signed in on another device.
    const second = await refresh(prisma, session.refreshToken);

    await deleteAccount(prisma, session.user.id);

    const tokens = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((t) => t.revokedAt !== null)).toBe(true);

    await expect(refresh(prisma, second.refreshToken)).rejects.toThrow();
  });

  it("makes the original phone unusable for login", async () => {
    const { user, phone } = await newRider();

    await deleteAccount(prisma, user.id);

    await expect(
      login(prisma, {
        phone,
        verifiedToken: signVerificationToken({ phone, purpose: "LOGIN" }),
      }),
    ).rejects.toThrow(UserNotFoundError);
  });

  it("frees the phone number for a fresh signup", async () => {
    const { user, phone } = await newRider();
    await deleteAccount(prisma, user.id);

    // The unique index is satisfied because the old row now holds a
    // placeholder, so the same person can come back as a NEW account.
    const reborn = await signup(prisma, {
      phone,
      name: "Returning Rider",
      role: "RIDER",
      verifiedToken: signVerificationToken({ phone, purpose: "SIGNUP" }),
    });
    userIds.push(reborn.user.id);
    expect(reborn.user.id).not.toBe(user.id);
  });

  it("PRESERVES ride history and the commission ledger", async () => {
    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    driverUserIds.push(driver.user.id);

    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driver.user.id,
    });
    rideIds.push(ride.id);

    const { commission } = splitFare(getLoneFare());
    await prisma.commissionLedger.create({
      data: { driverUserId: driver.user.id, rideId: ride.id, amountPesewas: commission },
    });

    await deleteAccount(prisma, rider.id);

    // Ride.riderId is onDelete: Restrict — the row must still be there, still
    // pointing at the (now anonymous) user, with the money record intact.
    const rideAfter = await prisma.ride.findUnique({ where: { id: ride.id } });
    expect(rideAfter).not.toBeNull();
    expect(rideAfter!.riderId).toBe(rider.id);

    const ledger = await prisma.commissionLedger.findUnique({ where: { rideId: ride.id } });
    expect(ledger).not.toBeNull();
    expect(ledger!.amountPesewas).toBe(commission);
  });

  it("clears identifying driver-profile fields and takes the driver offline", async () => {
    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    driverUserIds.push(driver.user.id);
    await prisma.driver.update({
      where: { userId: driver.user.id },
      data: { plate: "GR-1234-24", photoUrl: "https://example.com/face.jpg" },
    });

    await deleteAccount(prisma, driver.user.id);

    const after = await prisma.driver.findUniqueOrThrow({ where: { userId: driver.user.id } });
    expect(after.plate).toBeNull();
    expect(after.photoUrl).toBeNull();
    expect(after.isOnline).toBe(false);
    expect(after.isApproved).toBe(false);
  });

  it("refuses while a ride is still in flight", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "IN_PROGRESS" });
    rideIds.push(ride.id);

    await expect(deleteAccount(prisma, rider.id)).rejects.toThrow(ActiveRideBlocksDeletionError);

    // Nothing was written — the account is untouched, not half-deleted.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: rider.id } });
    expect(after.deletedAt).toBeNull();
    expect(after.name).not.toBe(DELETED_NAME_PLACEHOLDER);
  });

  it("refuses for a driver assigned to an in-flight ride", async () => {
    const driver = await createTestDriver({ isOnline: true, isApproved: true });
    driverUserIds.push(driver.user.id);
    const { ride } = await createTestRide({
      type: "LONE",
      status: "IN_PROGRESS",
      driverId: driver.user.id,
    });
    rideIds.push(ride.id);

    await expect(deleteAccount(prisma, driver.user.id)).rejects.toThrow(
      ActiveRideBlocksDeletionError,
    );
  });

  it("allows deletion once the ride is COMPLETED", async () => {
    const { ride, rider } = await createTestRide({ type: "LONE", status: "COMPLETED" });
    rideIds.push(ride.id);

    await expect(deleteAccount(prisma, rider.id)).resolves.toEqual({
      purgeAfter: expect.any(Date),
    });
  });

  it("rejects a second deletion", async () => {
    const { user } = await newRider();
    await deleteAccount(prisma, user.id);

    await expect(deleteAccount(prisma, user.id)).rejects.toThrow(AccountAlreadyDeletedError);
  });

  it("rejects an unknown user id", async () => {
    await expect(deleteAccount(prisma, "no-such-user")).rejects.toThrow(AccountAlreadyDeletedError);
  });
});

const DAY = 24 * 60 * 60_000;

describe("what closing an account keeps, and for how long", () => {
  it("moves the details a safety dispute needs out of sight, for 90 days", async () => {
    const now = new Date();
    const { user: driver } = await createTestDriver();
    driverUserIds.push(driver.id);
    await prisma.driver.update({
      where: { userId: driver.id },
      data: { plate: "GR-77-26", photoUrl: "https://example.com/p.jpg" },
    });
    await prisma.user.update({
      where: { id: driver.id },
      data: { emergencyContactName: "Auntie", emergencyContactPhone: "+233240000111" },
    });
    const original = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });

    const { purgeAfter } = await deleteAccount(prisma, driver.id, now);
    expect(purgeAfter.getTime() - now.getTime()).toBe(90 * DAY);

    const kept = await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: driver.id } });
    expect(kept).toMatchObject({
      keptName: original.name,
      keptPhone: original.phone,
      keptPlate: "GR-77-26",
      keptPhotoUrl: "https://example.com/p.jpg",
      purgedAt: null,
    });
    const after = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    expect(after).toMatchObject({ emergencyContactName: null, emergencyContactPhone: null });
    expect(
      await prisma.adminAuditLog.count({ where: { action: "account.delete", target: driver.id } }),
    ).toBe(1);
  });

  it("removes the rider's SOS tracking links and pending codes at once", async () => {
    const { user, phone } = await newRider();
    const { ride } = await createTestRide({ type: "LONE", status: "COMPLETED" });
    rideIds.push(ride.id);
    await prisma.trackingLink.create({
      data: { token: `t${Date.now()}`, rideId: ride.id, riderId: user.id },
    });
    await prisma.otpCode.create({
      data: { phone, codeHash: "x", purpose: "LOGIN", expiresAt: new Date(Date.now() + 60_000) },
    });
    await deleteAccount(prisma, user.id);
    expect(await prisma.trackingLink.count({ where: { riderId: user.id } })).toBe(0);
    expect(await prisma.otpCode.count({ where: { phone } })).toBe(0);
  });

  it("after the retention period, erases the kept details, notes, pins and comments; the trip stays", async () => {
    const t0 = new Date();
    const { user: driver } = await createTestDriver();
    driverUserIds.push(driver.id);
    const { ride, rider } = await createTestRide({
      type: "LONE",
      status: "COMPLETED",
      driverId: driver.id,
    });
    rideIds.push(ride.id);
    await prisma.ride.update({
      where: { id: ride.id },
      data: {
        pickupLat: 5.65,
        pickupLng: -0.18,
        pickupLabel: "Main gate",
        pickupNote: "blue gate",
        riderCancelNote: "x",
        fareTotal: 1500,
      },
    });
    await prisma.ridePassenger.create({
      data: {
        rideId: ride.id,
        riderId: rider.id,
        pickupZoneId: ride.pickupZoneId,
        dropoffZoneId: ride.dropoffZoneId,
        status: "DROPPED_OFF",
        pickupLat: 5.65,
        pickupNote: "blue gate",
      },
    });
    await prisma.rating.create({
      data: {
        rideId: ride.id,
        raterId: rider.id,
        rateeId: driver.id,
        stars: 2,
        comment: "late again",
      },
    });
    await prisma.driver.update({
      where: { userId: driver.id },
      data: { photoUrl: "https://example.com/d.jpg" },
    });

    await deleteAccount(prisma, rider.id, t0);
    await deleteAccount(prisma, driver.id, t0);
    const destroyPhoto = vi.fn(async () => true);
    const ids = [rider.id, driver.id];

    // Not yet: a day before the end of the retention period.
    expect(
      await purgeDeletedAccounts(prisma, new Date(t0.getTime() + 89 * DAY), {
        destroyPhoto,
        userIds: ids,
      }),
    ).toBe(0);
    expect(
      (await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: rider.id } })).keptPhone,
    ).not.toBeNull();

    expect(
      await purgeDeletedAccounts(prisma, new Date(t0.getTime() + 90 * DAY), {
        destroyPhoto,
        userIds: ids,
      }),
    ).toBe(2);
    for (const userId of ids) {
      expect(await prisma.accountDeletion.findUniqueOrThrow({ where: { userId } })).toMatchObject({
        purgedAt: expect.any(Date),
        keptName: null,
        keptPhone: null,
        keptPlate: null,
        keptPhotoUrl: null,
      });
      expect(
        await prisma.adminAuditLog.count({ where: { action: "account.purge", target: userId } }),
      ).toBe(1);
    }
    expect(destroyPhoto).toHaveBeenCalledWith(driver.id);
    expect(destroyPhoto).toHaveBeenCalledTimes(1);

    const after = await prisma.ride.findUniqueOrThrow({
      where: { id: ride.id },
      include: { passengers: true, ratings: true },
    });
    expect(after).toMatchObject({
      pickupLat: null,
      pickupLng: null,
      pickupLabel: null,
      pickupNote: null,
      riderCancelNote: null,
    });
    expect(after).toMatchObject({
      status: "COMPLETED",
      fareTotal: 1500,
      pickupZoneId: ride.pickupZoneId,
    });
    expect(after.passengers[0]).toMatchObject({ pickupLat: null, pickupNote: null });
    expect(after.ratings[0]).toMatchObject({ stars: 2, comment: null });

    // Running again changes nothing.
    expect(
      await purgeDeletedAccounts(prisma, new Date(t0.getTime() + 91 * DAY), {
        destroyPhoto,
        userIds: ids,
      }),
    ).toBe(0);
  });
});

describe("destroyDriverPhoto", () => {
  const cfg = { cloudName: "demo", apiKey: "key", apiSecret: "secret" };

  it("asks Cloudinary to delete the driver's photo, signed", async () => {
    let call: { url: string; body: URLSearchParams } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      call = { url, body: init.body as URLSearchParams };
      return new Response(JSON.stringify({ result: "ok" }));
    }) as unknown as typeof fetch;
    expect(await destroyDriverPhoto("u1", cfg, fetchFn, new Date(1_700_000_000_000))).toBe(true);
    expect(call!.url).toBe("https://api.cloudinary.com/v1_1/demo/image/destroy");
    expect(call!.body.get("public_id")).toBe("campusride/driver-photos/driver_u1");
    expect(call!.body.get("signature")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("treats an already-missing photo as done, and a failure as not done", async () => {
    const answer = (status: number, body: unknown) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await destroyDriverPhoto("u1", cfg, answer(200, { result: "not found" }))).toBe(true);
    expect(await destroyDriverPhoto("u1", cfg, answer(401, { error: "bad" }))).toBe(false);
    expect(await destroyDriverPhoto("u1", { cloudName: "", apiKey: "", apiSecret: "" })).toBe(
      false,
    );
  });
});
