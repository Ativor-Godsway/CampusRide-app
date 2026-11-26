/**
 * `npm run staging:secrets --workspace apps/server [-- --api-url https://….onrender.com]`
 * — prepares the staging server's settings (STAGING.md), printing NO value:
 *
 * 1. adds to apps/server/.env.staging what is missing: a NEW JWT_SECRET (32
 *    random bytes, never production's), the fixed STAGING_TEST_OTP for the
 *    test numbers, and STAGING_API_URL (where the staging server answers);
 * 2. writes apps/server/.env.staging.render: every variable the Render
 *    service needs, KEY=value per line, ready for Render's "Add from .env".
 *
 * Both files are gitignored (`.env.*`). Running it again keeps existing
 * values (the apps and the server must keep agreeing on them).
 */
import "./env"; // MUST stay first: loads .env.staging and refuses anything but the staging branch.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { SERVER_ROOT, STAGING_ENV_FILE } from "./env";

export const RENDER_ENV_FILE = path.join(SERVER_ROOT, ".env.staging.render");
export const DEFAULT_STAGING_API_URL = "https://campusride-staging-api.onrender.com";
/** The staging admin's number (scripts/staging/accounts.ts): admin allowlist and SOS contact on staging. */
const STAGING_ADMIN_PHONE = "+233990000021";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const added: string[] = [];
  const ensure = (name: string, make: () => string) => {
    if (process.env[name]?.trim()) return;
    const value = make();
    fs.appendFileSync(STAGING_ENV_FILE, `${name}="${value}"\n`, { mode: 0o600 });
    process.env[name] = value;
    added.push(name);
  };
  ensure("JWT_SECRET", () => randomBytes(32).toString("hex"));
  ensure("STAGING_TEST_OTP", () => String(randomInt(100_000, 1_000_000)));
  ensure("STAGING_API_URL", () => (arg("api-url") ?? DEFAULT_STAGING_API_URL).replace(/\/$/, ""));
  const apiUrl = process.env.STAGING_API_URL!;
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(apiUrl)) throw new Error("STAGING_API_URL must be an https:// address with no path.");

  // What the Render service runs with. Production-like (NODE_ENV=production)
  // plus CAMPUSRIDE_ENV=staging: no SMS (no OTP_PROVIDER), no Moolre, no
  // review demo, no USSD; push on (only staging app builds ever register
  // with this server). Optional lines are commented out.
  const lines = [
    "# CampusRide STAGING server — paste into Render (Environment → Add from .env). Gitignored. Never commit.",
    "NODE_ENV=production",
    "CAMPUSRIDE_ENV=staging",
    `DATABASE_URL=${process.env.DATABASE_URL}`,
    `DIRECT_URL=${process.env.DIRECT_URL}`,
    `JWT_SECRET=${process.env.JWT_SECRET}`,
    `STAGING_TEST_OTP=${process.env.STAGING_TEST_OTP}`,
    `PUBLIC_BASE_URL=${apiUrl}`,
    "CORS_ALLOWED_ORIGINS=http://localhost:5173",
    `ADMIN_PHONE_ALLOWLIST=${STAGING_ADMIN_PHONE}`,
    `SUPPORT_CONTACT_PHONE=${STAGING_ADMIN_PHONE}`,
    `SUPPORT_PHONE=${STAGING_ADMIN_PHONE}`,
    "ADMIN_PASSKEY_RP_ID=localhost",
    "ADMIN_PASSKEY_ORIGINS=http://localhost:5173",
    "DRIVER_OFFER_SECONDS=20",
    "# Optional: a Paystack TEST key (sk_test_…), never a live one (the server refuses sk_live_ on staging).",
    "# PAYSTACK_SECRET_KEY=sk_test_…",
    "# Optional: only if push notifications need an Expo access token in production too (a separate robot token for staging).",
    "# EXPO_ACCESS_TOKEN=…",
    "# Optional: driver photo uploads (else they answer 503 on staging).",
    "# CLOUDINARY_CLOUD_NAME=… CLOUDINARY_API_KEY=… CLOUDINARY_API_SECRET=…",
  ];
  fs.writeFileSync(RENDER_ENV_FILE, `${lines.join("\n")}\n`, { mode: 0o600 });
  console.log(`\n${added.length ? `Added to apps/server/.env.staging: ${added.join(", ")}.` : "apps/server/.env.staging already had its secrets (kept)."}`);
  console.log("Render settings written to apps/server/.env.staging.render (gitignored). Values not shown.\n");
}

try {
  main();
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
}
