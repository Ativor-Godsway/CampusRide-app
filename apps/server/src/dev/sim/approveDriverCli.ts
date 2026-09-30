/**
 * `npm run sim:approve-driver -- <phone>` — approves YOUR driver account on the
 * dev database, so it can go online without an admin. Run with no phone to list
 * the drivers there. Dev database / local Postgres only. See
 * docs/testing/SOLO_TESTING.md.
 */
import "./simEnv"; // MUST stay first: loads .env.development and refuses production.
import { PrismaClient } from "@prisma/client";
import { normalizePhone } from "../../lib/phone";

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    const raw = process.argv[2];
    if (!raw) {
      const drivers = await prisma.driver.findMany({
        include: { user: { select: { name: true, phone: true } } },
        orderBy: { createdAt: "asc" },
      });
      if (drivers.length === 0) {
        console.log("\nNo driver accounts on this database yet. Sign up in the driver app first.\n");
        return;
      }
      console.log("\nDrivers on this database:");
      for (const d of drivers) {
        console.log(
          `  ${d.user.phone}  ${d.user.name.padEnd(20)} ${d.isApproved ? "approved" : "NOT approved"}` +
            `${d.isOnline ? ", online" : ""}`,
        );
      }
      console.log("\nApprove one with: npm run sim:approve-driver -- <phone>\n");
      return;
    }

    const phone = normalizePhone(raw);
    if (!phone) throw new Error(`"${raw}" is not a Ghanaian phone number`);
    const user = await prisma.user.findUnique({ where: { phone }, include: { driver: true } });
    if (!user?.driver) {
      console.error(`\n✗ No driver account with phone ${phone}. Sign up in the driver app first.\n`);
      process.exitCode = 1;
      return;
    }
    await prisma.driver.update({ where: { id: user.driver.id }, data: { isApproved: true } });
    console.log(`\n✓ ${user.name} (${phone}) is approved. You can go online in the driver app now.\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
