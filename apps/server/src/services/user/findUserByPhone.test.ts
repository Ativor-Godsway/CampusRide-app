/**
 * After the phone-canonicalisation migration, User.phone is always
 * "+233XXXXXXXXX" (a CHECK constraint enforces it), so these lookups are no
 * longer about a mixed COLUMN. They are about mixed INPUT: an operator running
 * seedAdmin types "0548608146", a support tool gets a number pasted with
 * spaces, a USSD callback sends "233548608146". All of those must find the one
 * canonical row.
 *
 * The original bug this guards against: seedAdmin reported "no user with phone
 * +233548608146" for an account that existed, because the two sides disagreed
 * on spelling.
 */
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { prisma } from "../../db/prisma";
import { findUserByPhone, findUsersByPhone } from "./findUserByPhone";

const createdUserIds: string[] = [];

/** Creates a user at the canonical spelling the column now guarantees. */
async function canonicalUser(phone: string) {
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
  it("finds the canonical row from local-format input", async () => {
    // Exactly the reported case, from the operator's side.
    const user = await canonicalUser("+233548608146");
    expect((await findUserByPhone(prisma, "0548608146"))?.id).toBe(user.id);
  });

  it("finds the canonical row from canonical input", async () => {
    const user = await canonicalUser("+233548608147");
    expect((await findUserByPhone(prisma, "+233548608147"))?.id).toBe(user.id);
  });

  it("finds the canonical row from the bare msisdn USSD sends", async () => {
    const user = await canonicalUser("+233548608148");
    expect((await findUserByPhone(prisma, "233548608148"))?.id).toBe(user.id);
  });

  it("matches through spaces and dashes in the input", async () => {
    const user = await canonicalUser("+233548608149");
    expect((await findUserByPhone(prisma, "054-860 8149"))?.id).toBe(user.id);
    expect((await findUserByPhone(prisma, "+233 54 860 8149"))?.id).toBe(user.id);
  });

  it("returns null when nothing matches", async () => {
    expect(await findUserByPhone(prisma, "0500000001")).toBeNull();
  });

  it("returns null rather than throwing for unparseable input", async () => {
    expect(await findUserByPhone(prisma, "not a phone")).toBeNull();
    expect(await findUserByPhone(prisma, "   ")).toBeNull();
  });
});

describe("findUsersByPhone", () => {
  it("returns the single canonical row whichever input form is used", async () => {
    const user = await canonicalUser("+233548608152");
    for (const input of ["0548608152", "+233548608152", "233548608152", "054 860 8152"]) {
      expect((await findUsersByPhone(prisma, input)).map((u) => u.id)).toEqual([user.id]);
    }
  });

  /**
   * The duplicate case this function was written to surface — one row from the
   * app, one from USSD — can no longer be CONSTRUCTED: the canonicalisation
   * migration merged the existing pairs, and the CHECK constraint plus the
   * unique index make two equivalent rows impossible. The plural return type
   * and seedAdmin's "refuse to promote an ambiguous number" guard are kept as
   * a belt-and-braces check on that invariant, not because it can be
   * exercised here.
   */
  it("returns an empty list for no match or bad input", async () => {
    expect(await findUsersByPhone(prisma, "0500000002")).toEqual([]);
    expect(await findUsersByPhone(prisma, "  ")).toEqual([]);
  });
});
