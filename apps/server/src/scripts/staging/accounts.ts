/**
 * `npm run staging:accounts --workspace apps/server` — creates (or repairs)
 * the staging test accounts on the staging database (STAGING.md):
 *
 * - 3 riders and 2 drivers (approved, a full car profile, nothing owed) and
 *   1 admin for the admin site;
 * - numbers +233 99 … — a range no Ghanaian network uses, which the app's
 *   phone field takes as typed ("99 000 0001") — that sign in with the fixed
 *   STAGING_TEST_OTP on the staging server only (lib/stagingMode.ts);
 * - age and terms already confirmed, so the apps go straight in.
 *
 * Safe to run again: it creates what is missing and resets the drivers to
 * approved, offline and owing nothing. Refuses a number already used by an
 * account that isn't one of these.
 */
import "./env"; // MUST stay first: loads .env.staging and refuses anything but the staging branch.
import { PrismaClient } from "@prisma/client";
import { TERMS_VERSION } from "@rida/shared";
import { STAGING_TEST_PHONE } from "../../lib/stagingMode";

export interface StagingAccount {
  phone: string;
  /** What to type after +233 in the apps' phone field. */
  typed: string;
  name: string;
  role: "RIDER" | "DRIVER" | "ADMIN";
  car?: { carMake: string; carModel: string; carColor: string; plate: string };
}

export const STAGING_ACCOUNTS: StagingAccount[] = [
  { phone: "+233990000001", typed: "99 000 0001", name: "Ama Staging", role: "RIDER" },
  { phone: "+233990000002", typed: "99 000 0002", name: "Kofi Staging", role: "RIDER" },
  { phone: "+233990000003", typed: "99 000 0003", name: "Esi Staging", role: "RIDER" },
  {
    phone: "+233990000011",
    typed: "99 000 0011",
    name: "Yaw Staging",
    role: "DRIVER",
    car: { carMake: "Toyota", carModel: "Vitz", carColor: "Silver", plate: "GT 9901-26" },
  },
  {
    phone: "+233990000012",
    typed: "99 000 0012",
    name: "Abena Staging",
    role: "DRIVER",
    car: { carMake: "Kia", carModel: "Picanto", carColor: "Red", plate: "GT 9902-26" },
  },
  { phone: "+233990000021", typed: "99 000 0021", name: "Admin Staging", role: "ADMIN" },
];

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const now = new Date();
    for (const a of STAGING_ACCOUNTS) {
      if (!STAGING_TEST_PHONE.test(a.phone)) throw new Error(`${a.phone} is not a staging test number`);
      const existing = await prisma.user.findUnique({ where: { phone: a.phone } });
      if (existing && (existing.role !== a.role || existing.name !== a.name)) {
        throw new Error(`${a.phone} already belongs to "${existing.name}" (${existing.role}). Refusing to change it.`);
      }
      const user =
        existing ??
        (await prisma.user.create({
          data: { phone: a.phone, name: a.name, role: a.role, ageConfirmedAt: now, termsAcceptedAt: now, termsVersion: TERMS_VERSION },
        }));
      if (existing && existing.termsVersion !== TERMS_VERSION) {
        await prisma.user.update({ where: { id: user.id }, data: { ageConfirmedAt: now, termsAcceptedAt: now, termsVersion: TERMS_VERSION } });
      }
      if (a.car) {
        const driver = { ...a.car, isApproved: true, isOnline: false, suspendedAt: null, suspendedReason: null, autoOfflineAt: null };
        await prisma.driver.upsert({ where: { userId: user.id }, update: driver, create: { userId: user.id, ...driver } });
        // Nothing owed: no commission rows for a test driver.
        await prisma.commissionLedger.deleteMany({ where: { driverUserId: user.id } });
      }
      console.log(`  ${a.role.padEnd(6)}  ${a.name.padEnd(14)}  ${a.phone}  (type ${a.typed})`);
    }
    console.log("\nSign in with the fixed code STAGING_TEST_OTP from apps/server/.env.staging.\n");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
}
