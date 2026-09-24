/**
 * Manual, one-off script that promotes an EXISTING user to ADMIN. This is the
 * only way an ADMIN account can come into being: POST /auth/signup accepts
 * RIDER|DRIVER only (see SignupRole in services/auth/authService.ts), so the
 * role can never be self-declared over the public API.
 *
 * Run by hand, by an operator, against the target database. NOT run by the
 * test suite, CI, or the app.
 *
 * Usage (phone as an argument, or as ADMIN_PHONE):
 *
 *   # local / development
 *   npx dotenv -e .env.development -- npx ts-node -r tsconfig-paths/register \
 *     src/scripts/seedAdmin.ts 0594826328
 *
 *   # production — DATABASE_URL must point at the production database
 *   DATABASE_URL="postgres://..." ADMIN_PHONE=0594826328 \
 *     npx ts-node -r tsconfig-paths/register src/scripts/seedAdmin.ts
 *
 * The user must already exist (sign up in the rider app first). The promotion
 * is recorded in AdminAuditLog with actor "script:seedAdmin", so a role change
 * made outside the admin app is still visible in the same log.
 */
import { config } from "../config";
import { prisma } from "../db/prisma";
import { normalizePhone } from "../lib/phone";

async function main() {
  const raw = process.argv[2] ?? process.env.ADMIN_PHONE;
  if (!raw) {
    console.error("Usage: seedAdmin.ts <phone>   (or set ADMIN_PHONE)");
    process.exit(1);
  }

  const phone = normalizePhone(raw);
  if (!phone) {
    console.error(`"${raw}" is not a valid Ghanaian phone number (expected 0XXXXXXXXX or +233XXXXXXXXX).`);
    process.exit(1);
    return;
  }

  const user = await prisma.user.findUnique({ where: { phone } });

  if (!user) {
    console.error(
      `No user with phone ${phone}. Sign that number up in the app first, then re-run this script.`,
    );
    process.exit(1);
  }

  if (user.deletedAt) {
    console.error(`User ${phone} is deleted and cannot be promoted.`);
    process.exit(1);
  }

  if (user.role === "ADMIN") {
    console.log(`${user.name} (${phone}) is already an ADMIN — nothing to do.`);
    return;
  }

  const previousRole = user.role;

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } }),
    prisma.adminAuditLog.create({
      data: {
        actor: "script:seedAdmin",
        action: "user.promoteToAdmin",
        target: user.id,
        reason: `Promoted from ${previousRole} by seedAdmin script (${config.nodeEnv})`,
      },
    }),
  ]);

  console.log(`Promoted ${user.name} (${phone}) from ${previousRole} to ADMIN.`);
  console.log("They must log out and log back in — existing access tokens still carry the old role.");
}

main()
  .catch((err) => {
    console.error("seedAdmin failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
