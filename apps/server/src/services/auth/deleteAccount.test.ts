import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { splitFare, getLoneFare } from "@rida/shared";
import {
  AccountAlreadyDeletedError,
  ActiveRideBlocksDeletionError,
  DELETED_NAME_PLACEHOLDER,
  deleteAccount,
  deletedPhonePlaceholder,
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

    await expect(deleteAccount(prisma, rider.id)).resolves.toBeUndefined();
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
