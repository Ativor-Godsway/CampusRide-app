/**
 * The bug this pins: seedAdmin reported "no user with phone +233548608146"
 * for an account that existed, because the auth routes had stored it as
 * "0548608146". A lookup has to match every equivalent stored format.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { findUserByPhone, findUsersByPhone } from "./findUserByPhone";

const createdUserIds: string[] = [];

/** Creates a user with an EXACT stored phone string — no normalization. */
async function userStoredAs(phone: string) {
  const user = await prisma.user.create({
    data: { phone, name: `Phone fixture ${phone}`, role: "RIDER" },
  });
  createdUserIds.push(user.id);
  return user;
}

afterEach(async () => {
  while (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: createdUserIds.pop()! } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("findUserByPhone", () => {
  it("finds a locally-stored number when asked for the canonical form", async () => {
    // Exactly the reported case.
    const user = await userStoredAs("0548608146");
    const found = await findUserByPhone(prisma, "+233548608146");
    expect(found?.id).toBe(user.id);
  });

  it("finds a canonically-stored number when asked for the local form", async () => {
    const user = await userStoredAs("+233548608147");
    const found = await findUserByPhone(prisma, "0548608147");
    expect(found?.id).toBe(user.id);
  });

  it("finds a number stored in the bare msisdn form USSD uses", async () => {
    const user = await userStoredAs("233548608148");
    expect((await findUserByPhone(prisma, "0548608148"))?.id).toBe(user.id);
    expect((await findUserByPhone(prisma, "+233548608148"))?.id).toBe(user.id);
  });

  it("matches through spaces and dashes in the query", async () => {
    const user = await userStoredAs("0548608149");
    expect((await findUserByPhone(prisma, "054-860 8149"))?.id).toBe(user.id);
  });

  it("returns null when nothing matches any format", async () => {
    expect(await findUserByPhone(prisma, "0500000001")).toBeNull();
  });

  it("returns null rather than throwing for an unparseable input", async () => {
    expect(await findUserByPhone(prisma, "not a phone")).toBeNull();
    expect(await findUserByPhone(prisma, "   ")).toBeNull();
  });

  it("prefers the canonical row when the same number exists in two formats", async () => {
    // The duplicate-account case: one row from the app, one from USSD.
    const local = await userStoredAs("0548608150");
    const canonical = await userStoredAs("+233548608150");

    const found = await findUserByPhone(prisma, "0548608150");
    expect(found?.id).toBe(canonical.id);
    expect(found?.id).not.toBe(local.id);
  });
});

describe("findUsersByPhone", () => {
  it("surfaces BOTH rows when a number was registered through two paths", async () => {
    const local = await userStoredAs("0548608151");
    const canonical = await userStoredAs("+233548608151");

    const found = await findUsersByPhone(prisma, "0548608151");
    expect(found.map((u) => u.id).sort()).toEqual([local.id, canonical.id].sort());
  });

  it("returns a single row for the ordinary case", async () => {
    const user = await userStoredAs("0548608152");
    const found = await findUsersByPhone(prisma, "+233548608152");
    expect(found.map((u) => u.id)).toEqual([user.id]);
  });

  it("returns an empty list for no match or bad input", async () => {
    expect(await findUsersByPhone(prisma, "0500000002")).toEqual([]);
    expect(await findUsersByPhone(prisma, "  ")).toEqual([]);
  });
});
