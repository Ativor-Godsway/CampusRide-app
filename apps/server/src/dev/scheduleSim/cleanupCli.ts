/**
 * `npm run staging:fake-schedule:cleanup` — removes the fake riders'
 * scheduled bookings (and cars only they were in), then the fake riders and
 * their rides (dev/sim/cleanup.ts). Staging only. Real staging accounts and
 * their bookings stay.
 */
import "../requestSim/env"; // MUST stay first: loads .env.staging (with --staging) and refuses anything else.
import { PrismaClient } from "@prisma/client";
import { dbHostFromUrl } from "../../db/dbHostGuard";
import { cleanupSimulatorData, SimCleanupEntangledError } from "../sim/cleanup";
import { isSimulatorPhone, simAccountWhere } from "../sim/simAccounts";

async function main(): Promise<void> {
  const prisma = new PrismaClient({ log: ["error"] });
  try {
    console.log(`\nRemoving fake scheduled rides from ${dbHostFromUrl(process.env.DATABASE_URL ?? "")}…`);
    const ids = (await prisma.user.findMany({ where: simAccountWhere, select: { id: true, phone: true } })).filter((u) => isSimulatorPhone(u.phone)).map((u) => u.id);
    const cars = await prisma.scheduledCar.findMany({ where: { bookings: { some: { riderId: { in: ids } } } }, include: { bookings: { select: { riderId: true } } } });
    const onlyFake = cars.filter((c) => c.bookings.every((b) => ids.includes(b.riderId))).map((c) => c.id);
    const removedCars = (await prisma.scheduledCar.deleteMany({ where: { id: { in: onlyFake } } })).count;
    const removedBookings = (await prisma.scheduledBooking.deleteMany({ where: { riderId: { in: ids } } })).count;
    await prisma.scheduleStrike.deleteMany({ where: { riderId: { in: ids } } });
    console.log(`Removed ${removedCars} scheduled cars and ${removedBookings} more fake bookings.`);
    const r = await cleanupSimulatorData(prisma);
    console.log(r.accounts === 0 ? "No fake riders left.\n" : `Removed ${r.accounts} fake riders and ${r.rides} rides.\n`);
  } catch (err) {
    if (err instanceof SimCleanupEntangledError) {
      console.error(`\n✗ ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
