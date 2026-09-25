/**
 * Removes test-fixture accounts, and everything attached to them, from a
 * database they should never have reached.
 *
 * See docs/incident-2026-09-24-test-rows-in-production.md.
 *
 *   # 1. DRY RUN (the default — prints the plan, writes nothing)
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="postgres://…" \
 *     npx ts-node -r tsconfig-paths/register src/scripts/cleanupTestAccounts.ts
 *
 *   # 2. Apply, after reading the plan
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="postgres://…" \
 *     npx ts-node -r tsconfig-paths/register src/scripts/cleanupTestAccounts.ts --apply
 *
 * ALLOW_PRODUCTION_DB=1 is required because db/prisma.ts refuses to open a
 * connection to a known production host from a non-production process. Paste
 * the production URL inline for the one-off; it should not live in any .env.
 *
 * WHAT IT TARGETS: only accounts whose phone CANNOT be a real number —
 * "+233-2a-test-…", "+233-auth-test-…" (the old fixture generators) and the
 * reserved "+2330…" prefix used by fixtures now. A real subscriber number can
 * never match, which is the entire safety argument for deleting by pattern.
 *
 * WHAT IT REFUSES TO TOUCH: rows created by the USSD tests, which used to
 * generate structurally valid numbers and are named "USSD Rider" exactly like
 * genuine USSD riders. There is no way to tell those apart from customers
 * without guessing, and guessing wrong destroys a real person's ride history.
 * They need a human decision — see the inventory query, block 5.
 *
 * It also aborts rather than deleting if a fixture turns out to be entangled
 * with a real account, or to carry money.
 */
import { prisma } from "../db/prisma";
import { dbHostFromUrl } from "../db/dbHostGuard";

/** Phone patterns that cannot belong to a real subscriber. */
const FIXTURE_PHONE_PATTERNS = [
  { label: "ride fixtures (createTestUser)", startsWith: "+233-2a-test-" },
  { label: "auth fixtures (uniqueTestPhone)", startsWith: "+233-auth-test-" },
  { label: "reserved fixture prefix", startsWith: "+2330" },
];

const APPLY = process.argv.includes("--apply");

function heading(text: string): void {
  console.log(`\n${"─".repeat(70)}\n${text}\n${"─".repeat(70)}`);
}

async function main() {
  const host = dbHostFromUrl(process.env.DATABASE_URL ?? "") ?? "(unknown)";

  heading(`Test-account cleanup — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`Target host: ${host}`);
  console.log(APPLY ? "Mode: WILL DELETE" : "Mode: dry run — nothing will be written");

  const where = { OR: FIXTURE_PHONE_PATTERNS.map((p) => ({ phone: { startsWith: p.startsWith } })) };

  const users = await prisma.user.findMany({
    where,
    select: { id: true, phone: true, name: true, role: true, createdAt: true },
  });

  if (users.length === 0) {
    console.log("\nNo fixture accounts found. Nothing to do.");
    return;
  }

  const ids = users.map((u) => u.id);
  const phones = users.map((u) => u.phone);

  heading(`Found ${users.length} fixture account(s)`);
  for (const pattern of FIXTURE_PHONE_PATTERNS) {
    const n = users.filter((u) => u.phone.startsWith(pattern.startsWith)).length;
    if (n > 0) console.log(`  ${String(n).padStart(5)}  ${pattern.label}`);
  }

  // ── Attached rows ─────────────────────────────────────────────────────────
  const [
    drivers, ridesAsRider, ridesAsDriver, passengers, payments,
    ratings, commission, rejections, tokens, otpCodes,
  ] = await Promise.all([
    prisma.driver.count({ where: { userId: { in: ids } } }),
    prisma.ride.count({ where: { riderId: { in: ids } } }),
    prisma.ride.count({ where: { driverId: { in: ids } } }),
    prisma.ridePassenger.count({ where: { riderId: { in: ids } } }),
    prisma.payment.count({ where: { riderId: { in: ids } } }),
    prisma.rating.count({ where: { OR: [{ raterId: { in: ids } }, { rateeId: { in: ids } }] } }),
    prisma.commissionLedger.count({ where: { driverUserId: { in: ids } } }),
    prisma.rideRejection.count({ where: { driverUserId: { in: ids } } }),
    prisma.refreshToken.count({ where: { userId: { in: ids } } }),
    prisma.otpCode.count({ where: { phone: { in: phones } } }),
  ]);

  heading("Attached rows that would be deleted");
  for (const [label, n] of [
    ["Driver profiles", drivers],
    ["Rides (as rider)", ridesAsRider],
    ["Rides (as driver)", ridesAsDriver],
    ["Ride passenger rows", passengers],
    ["Payments", payments],
    ["Ratings", ratings],
    ["Commission ledger rows", commission],
    ["Ride rejections", rejections],
    ["Refresh tokens", tokens],
    ["OTP codes", otpCodes],
  ] as const) {
    console.log(`  ${String(n).padStart(5)}  ${label}`);
  }

  // ── Safety checks ─────────────────────────────────────────────────────────
  // A fixture entangled with a real account is not a fixture problem any more.
  const entangledRides = await prisma.ride.findMany({
    where: {
      OR: [
        { riderId: { in: ids }, driverId: { not: null, notIn: ids } },
        { driverId: { in: ids }, riderId: { notIn: ids } },
      ],
    },
    select: { id: true, status: true, riderId: true, driverId: true },
  });

  const entangledPassengerRides = await prisma.ride.findMany({
    where: {
      passengers: { some: { riderId: { in: ids } } },
      AND: [{ passengers: { some: { riderId: { notIn: ids } } } }],
    },
    select: { id: true },
  });

  const problems: string[] = [];
  if (entangledRides.length > 0) {
    problems.push(
      `${entangledRides.length} ride(s) pair a fixture account with a REAL account: ` +
        entangledRides.slice(0, 10).map((r) => r.id).join(", "),
    );
  }
  if (entangledPassengerRides.length > 0) {
    problems.push(
      `${entangledPassengerRides.length} shared ride(s) carry both fixture and real passengers: ` +
        entangledPassengerRides.slice(0, 10).map((r) => r.id).join(", "),
    );
  }
  if (commission > 0) {
    problems.push(`${commission} commission ledger row(s) — platform debt attached to a fixture`);
  }
  if (payments > 0) {
    problems.push(`${payments} payment row(s) — financial record attached to a fixture`);
  }

  if (problems.length > 0) {
    heading("REFUSING TO PROCEED");
    for (const p of problems) console.log(`  ✗ ${p}`);
    console.log(
      "\nThese rows touch real accounts or real money, so they are not safely\n" +
        "deletable by pattern. Resolve them by hand, then re-run.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n  ✓ No fixture row is entangled with a real account or with money.");

  // ── The ambiguous group, reported but never touched ───────────────────────
  const ussdLookalikes = await prisma.user.count({
    where: { name: "USSD Rider", phone: { startsWith: "+233" }, NOT: where },
  });
  if (ussdLookalikes > 0) {
    heading("NOT touched by this script — needs a human");
    console.log(
      `  ${ussdLookalikes} account(s) named "USSD Rider" with structurally valid numbers.\n` +
        "  The old USSD tests produced rows identical in shape to genuine USSD\n" +
        "  riders, so these cannot be told apart automatically. Review them with\n" +
        "  block 5 of docs/sql/test-account-inventory.sql.",
    );
  }

  if (!APPLY) {
    heading("DRY RUN — nothing was written");
    console.log("Re-run with --apply to perform the deletion above.");
    return;
  }

  // ── Delete, in FK-safe order, in one transaction ──────────────────────────
  heading("Applying");
  const rideIds = (
    await prisma.ride.findMany({
      where: { OR: [{ riderId: { in: ids } }, { driverId: { in: ids } }] },
      select: { id: true },
    })
  ).map((r) => r.id);

  await prisma.$transaction(async (tx) => {
    // Children of Ride first: Ride.riderId/driverId are onDelete: Restrict,
    // so the rides themselves cannot go until nothing points at them.
    await tx.rating.deleteMany({ where: { rideId: { in: rideIds } } });
    await tx.ridePassenger.deleteMany({ where: { rideId: { in: rideIds } } });
    await tx.payment.deleteMany({ where: { rideId: { in: rideIds } } });
    await tx.commissionLedger.deleteMany({ where: { rideId: { in: rideIds } } });
    await tx.rideRejection.deleteMany({ where: { rideId: { in: rideIds } } });

    // Anything still referencing the users themselves.
    await tx.ridePassenger.deleteMany({ where: { riderId: { in: ids } } });
    await tx.rating.deleteMany({ where: { OR: [{ raterId: { in: ids } }, { rateeId: { in: ids } }] } });
    await tx.payment.deleteMany({ where: { riderId: { in: ids } } });
    await tx.commissionLedger.deleteMany({ where: { driverUserId: { in: ids } } });
    await tx.rideRejection.deleteMany({ where: { driverUserId: { in: ids } } });
    await tx.refreshToken.deleteMany({ where: { userId: { in: ids } } });
    await tx.otpCode.deleteMany({ where: { phone: { in: phones } } });

    // A merged ride points at another ride; clear the link before removing.
    await tx.ride.updateMany({
      where: { mergedIntoRideId: { in: rideIds } },
      data: { mergedIntoRideId: null },
    });
    await tx.ride.deleteMany({ where: { id: { in: rideIds } } });

    await tx.driver.deleteMany({ where: { userId: { in: ids } } });
    await tx.user.deleteMany({ where: { id: { in: ids } } });
  });

  const remaining = await prisma.user.count({ where });
  heading("Done");
  console.log(`Deleted ${users.length} fixture account(s) and their attached rows.`);
  console.log(`Fixture accounts remaining: ${remaining}`);
  if (remaining !== 0) {
    console.log("WARNING: expected 0 remaining. Investigate before proceeding.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("cleanupTestAccounts failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
