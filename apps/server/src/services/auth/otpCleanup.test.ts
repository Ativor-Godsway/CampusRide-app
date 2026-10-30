import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { uniqueGhanaPhone } from "../../test/testPhone";
import { OTP_KEEP_DAYS, purgeOldOtpCodes } from "./otpCleanup";

const phones: string[] = [];
afterEach(async () => {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones.splice(0) } } });
});

const DAY = 24 * 60 * 60_000;

async function code(ageDays: number, used: boolean) {
  const phone = uniqueGhanaPhone();
  phones.push(phone);
  const createdAt = new Date(Date.now() - ageDays * DAY);
  return prisma.otpCode.create({
    data: {
      phone,
      codeHash: "x".repeat(64),
      purpose: "LOGIN",
      createdAt,
      expiresAt: new Date(createdAt.getTime() + 10 * 60_000),
      consumedAt: used ? createdAt : null,
    },
  });
}

describe("purgeOldOtpCodes", () => {
  it("deletes codes older than a week, used or not; keeps the rest, the live one included", async () => {
    const oldUsed = await code(OTP_KEEP_DAYS + 1, true);
    const oldUnused = await code(OTP_KEEP_DAYS + 30, false);
    const recentUsed = await code(OTP_KEEP_DAYS - 1, true);
    const live = await code(0, false);

    expect(await purgeOldOtpCodes(prisma)).toBeGreaterThanOrEqual(2);
    const left = await prisma.otpCode.findMany({ where: { id: { in: [oldUsed.id, oldUnused.id, recentUsed.id, live.id] } } });
    expect(left.map((r) => r.id).sort()).toEqual([recentUsed.id, live.id].sort());
  });

  it("is harmless to run twice at once (two instances during a deploy)", async () => {
    await code(OTP_KEEP_DAYS + 2, true);
    await code(OTP_KEEP_DAYS + 3, false);
    const [a, b] = await Promise.all([purgeOldOtpCodes(prisma), purgeOldOtpCodes(prisma)]);
    expect(a + b).toBeGreaterThanOrEqual(2);
    expect(await prisma.otpCode.count({ where: { phone: { in: phones } } })).toBe(0);
  });
});
