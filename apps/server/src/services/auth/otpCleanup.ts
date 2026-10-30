import type { PrismaClient } from "@prisma/client";

/**
 * Login codes (OtpCode) are only of use for minutes: each expires after
 * OTP.OTP_TTL_MINUTES and verifying reads a number's newest one. Rows older
 * than OTP_KEEP_DAYS — used, expired or never used — are deleted, so the
 * table (phone numbers and code hashes) doesn't grow forever. A week is kept
 * for looking into a login complaint.
 *
 * Run at startup and on a timer (index.ts). Safe to run twice at once (two
 * instances during a deploy): each pass deletes by id what it just read, and
 * deleting rows already gone is no error. In batches, so one pass never
 * holds a long lock.
 */
export const OTP_KEEP_DAYS = 7;
const BATCH = 1_000;
/** Most rows one pass deletes; the next run carries on. */
const MAX_PER_RUN = 50_000;

/** Deletes login codes older than OTP_KEEP_DAYS. Returns how many. */
export async function purgeOldOtpCodes(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - OTP_KEEP_DAYS * 24 * 60 * 60_000);
  let deleted = 0;
  while (deleted < MAX_PER_RUN) {
    const old = await prisma.otpCode.findMany({
      where: { createdAt: { lt: before } },
      select: { id: true },
      take: BATCH,
    });
    if (old.length === 0) break;
    const { count } = await prisma.otpCode.deleteMany({ where: { id: { in: old.map((r) => r.id) } } });
    deleted += count;
    if (old.length < BATCH) break;
  }
  return deleted;
}
