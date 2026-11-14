/**
 * One-off, before the public launch: resets CampusRide to zero by deleting
 * every rider and driver account created before a cutoff, every ride and
 * trip record, and every commission and payment row (Finances back to zero).
 *
 *   # 1. DRY RUN (the default — prints counts and kept accounts, writes nothing)
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run reset:test-data -- --before=2026-11-16T00:00:00Z --keep=+233241234567
 *
 *   # 2. The real run: the same, plus --confirm=RESET-CAMPUSRIDE
 *
 * KEPT, always:
 *   - ADMIN accounts (their own rides and driver records before the cutoff
 *     still go: they're test trips), their passkeys and sessions;
 *   - review demo accounts (isReviewDemo, and the REVIEW_DEMO_RIDER_PHONE /
 *     REVIEW_DEMO_DRIVER_PHONE numbers) with ALL their rides and records;
 *   - the --keep numbers (canonical +233…), and every account created at or
 *     after --before, with their rides from then on;
 *   - the admin audit log, settings (launch mode, commission rules, prices),
 *     zones, places, routes and notification history: nothing that isn't a
 *     person's account or trip.
 *
 * DELETED:
 *   - the other accounts, and everything tied to them (driver record and car,
 *     sessions, push tokens, login codes, emergency contact and early access,
 *     which are columns on the account, closed-account records);
 *   - every non-demo ride created before the cutoff, and any ride involving a
 *     deleted account, with its seats, offers, rejections, ratings, payments,
 *     SOS records and tracking links;
 *   - commission owed, payments, waivers, adjustments and Paystack payment
 *     attempts: those of deleted drivers and all non-demo ones before the
 *     cutoff; driver online sessions and location trails the same way;
 *   - deleted drivers' photos in Cloudinary, after the database commit.
 *
 * Rate limits, positions and admin lookups live in the server's memory, not
 * the database: restart the server afterwards (Render → Manual Deploy →
 * Restart service) to clear them.
 *
 * SAFETY: dry run unless --confirm=RESET-CAMPUSRIDE. A known production
 * database is refused without ALLOW_PRODUCTION_DB=1, and the database's
 * endpoint id is printed before anything else. All database deletes are one
 * transaction (all or nothing). Cloudinary runs only after the commit, and
 * only for photos stored in the Cloudinary account the script was given;
 * failures are listed, not fatal. Phones are printed masked; no secret is
 * ever printed.
 */
// config FIRST: it loads the env-specific file (.env.test, .env.development)
// before @prisma/client, which reads the base .env as soon as it's imported.
import { config } from "../config";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db/prisma";
import { assertProductionOptIn, dbHostFromUrl, KNOWN_PROD_DB_HOSTS } from "../db/dbHostGuard";
import { normalizePhone } from "../lib/phone";
import { maskPhone, redactText } from "../lib/redact";
import { destroyCloudinaryImage } from "../services/auth/deleteAccount";
import { driverPhotoPublicId } from "../services/uploads/cloudinarySignature";
import { SCRIPT_TX_OPTIONS } from "./scriptTx";

export const CONFIRM_WORD = "RESET-CAMPUSRIDE";

export interface ResetOptions {
  /** Accounts created before this are deleted (unless kept); so are rides and money rows from before it. */
  before: Date;
  /** Canonical "+233…" numbers never deleted. */
  keepPhones: readonly string[];
  /** The review demo numbers (REVIEW_DEMO_RIDER_PHONE / _DRIVER_PHONE), kept even if the demo is off. */
  demoPhones: readonly string[];
  /** The Cloudinary account the script deletes photos from; photos stored in any other are left alone. */
  cloudName: string;
}

export interface KeptAccount {
  phone: string;
  role: string;
  why: "admin" | "review demo" | "--keep" | "created after the cutoff";
}

/** A Cloudinary image to delete once the database has committed. */
export interface PhotoTarget {
  userId: string;
  phone: string;
  publicId: string;
}

export interface PhotoProblem {
  phone: string;
  what: string;
}

export interface ResetPlan {
  /** Rows per table (or category) that a real run deletes. */
  counts: Array<{ label: string; rows: number }>;
  kept: KeptAccount[];
  photos: PhotoTarget[];
  /** Photos that can't be deleted (another Cloudinary account, not a Cloudinary link): listed, never fatal. */
  photoProblems: PhotoProblem[];
}

type Db = PrismaClient | Prisma.TransactionClient;

/** "https://res.cloudinary.com/<cloud>/image/upload/[transformations/][v123/]<public id>.<ext>" -> its parts. */
export function parseCloudinaryUrl(url: string): { cloudName: string; publicId: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "res.cloudinary.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [cloudName, resource, delivery, ...rest] = parts;
  if (!cloudName || resource !== "image" || delivery !== "upload" || rest.length === 0) return null;
  const version = rest.findIndex((p) => /^v\d+$/.test(p));
  let idParts: string[];
  if (version >= 0) idParts = rest.slice(version + 1);
  else {
    // No version: skip leading transformation segments like "c_fill,w_400".
    let i = 0;
    while (i < rest.length - 1 && /^[a-z]{1,3}_[^/]*(,[a-z]{1,3}_[^/]*)*$/.test(rest[i]!)) i += 1;
    idParts = rest.slice(i);
  }
  if (idParts.length === 0) return null;
  const publicId = idParts.join("/").replace(/\.[a-z0-9]+$/i, "");
  return publicId ? { cloudName, publicId } : null;
}

/** "--before=…" etc. Throws, in words, on anything it doesn't know or can't use. */
export function parseArgs(argv: readonly string[], now = new Date()): { options: Omit<ResetOptions, "demoPhones" | "cloudName">; confirm: boolean } {
  const known = new Set(["--before", "--keep", "--confirm"]);
  const values = new Map<string, string>();
  for (const arg of argv) {
    const [name, ...value] = arg.split("=");
    if (!name || !known.has(name) || value.length === 0) {
      throw new Error(`Unknown argument "${name ?? arg}". Use --before=<ISO time>, --keep=+233…,+233… and --confirm=${CONFIRM_WORD}.`);
    }
    values.set(name, value.join("="));
  }
  const rawBefore = values.get("--before");
  if (!rawBefore) throw new Error("--before=<ISO time> is required, e.g. --before=2026-11-16T00:00:00Z.");
  const before = new Date(rawBefore);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(rawBefore) || Number.isNaN(before.getTime())) {
    throw new Error(`--before must be an ISO time like 2026-11-16T00:00:00Z.`);
  }
  if (before.getTime() > now.getTime()) throw new Error("--before is in the future: pick a time that has passed.");
  const keepPhones = (values.get("--keep") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const phone of keepPhones) {
    if (normalizePhone(phone) !== phone) {
      throw new Error(`--keep has ${maskPhone(phone)}, which isn't in the canonical +233XXXXXXXXX form.`);
    }
  }
  const confirmValue = values.get("--confirm");
  if (confirmValue !== undefined && confirmValue !== CONFIRM_WORD) {
    throw new Error(`--confirm must be exactly ${CONFIRM_WORD}.`);
  }
  return { options: { before, keepPhones }, confirm: confirmValue === CONFIRM_WORD };
}

/** The review demo numbers from the environment, canonical, whether or not the demo is switched on. */
export function demoPhonesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.REVIEW_DEMO_RIDER_PHONE, env.REVIEW_DEMO_DRIVER_PHONE]
    .map((p) => normalizePhone(p ?? ""))
    .filter((p): p is string => p !== null);
}

/** Who and what a reset removes, worked out from the database as it is now. */
async function collect(db: Db, options: ResetOptions) {
  const { before } = options;
  const keptPhones = [...new Set([...options.keepPhones, ...options.demoPhones])];

  const users = await db.user.findMany({
    select: {
      id: true,
      phone: true,
      role: true,
      createdAt: true,
      isReviewDemo: true,
      driver: { select: { photoUrl: true } },
      accountDeletion: { select: { keptPhotoUrl: true } },
    },
  });
  const kept: KeptAccount[] = [];
  const doomed: typeof users = [];
  for (const u of users) {
    const why: KeptAccount["why"] | null =
      u.role === "ADMIN"
        ? "admin"
        : u.isReviewDemo || options.demoPhones.includes(u.phone)
          ? "review demo"
          : keptPhones.includes(u.phone)
            ? "--keep"
            : u.createdAt >= before
              ? "created after the cutoff"
              : null;
    if (why) kept.push({ phone: u.phone, role: u.role, why });
    else doomed.push(u);
  }
  const deletedIds = doomed.map((u) => u.id);
  const deletedPhones = doomed.map((u) => u.phone);
  const keptPhoneSet = [...new Set([...kept.map((k) => k.phone), ...keptPhones])];
  const demoUserIds = users.filter((u) => u.isReviewDemo || options.demoPhones.includes(u.phone)).map((u) => u.id);

  const D = { in: deletedIds };
  const touchesDeleted: Prisma.RideWhereInput[] = [
    { riderId: D },
    { driverId: D },
    { passengers: { some: { riderId: D } } },
    { payments: { some: { riderId: D } } },
    { ratings: { some: { OR: [{ raterId: D }, { rateeId: D }] } } },
    { commissionLedger: { is: { driverUserId: D } } },
  ];
  // Review demo rides are kept; one that involves a deleted account would
  // break that promise (or the foreign keys), so stop and say so.
  const entangled = await db.ride.count({ where: { isReviewDemo: true, OR: touchesDeleted } });
  if (entangled > 0) {
    throw new Error(`${entangled} review demo ride(s) involve an account that would be deleted: nothing was changed. Add that account to --keep.`);
  }
  const rideIds = (
    await db.ride.findMany({
      where: { isReviewDemo: false, OR: [{ createdAt: { lt: before } }, ...touchesDeleted] },
      select: { id: true },
    })
  ).map((r) => r.id);
  const R = { in: rideIds };

  // Money: deleted drivers' rows, and every non-demo row from before the cutoff.
  const moneyWhere = { OR: [{ driverUserId: D }, { createdAt: { lt: before }, driverUserId: { notIn: demoUserIds } }] };
  const paystackIds = (await db.driverPaystackPayment.findMany({ where: moneyWhere, select: { id: true } })).map((p) => p.id);
  let cashIds = (
    await db.driverCashPayment.findMany({
      where: { OR: [...moneyWhere.OR, { paystackPaymentId: { in: paystackIds } }] },
      select: { id: true },
    })
  ).map((c) => c.id);
  // A reversal can't outlive what it reverses (foreign key): take those along.
  for (let added = true; added; ) {
    const more = await db.driverCashPayment.findMany({
      where: { reversesId: { in: cashIds }, id: { notIn: cashIds } },
      select: { id: true },
    });
    cashIds = [...cashIds, ...more.map((c) => c.id)];
    added = more.length > 0;
  }
  const notDemoDriver = { driverUserId: { notIn: demoUserIds } };
  const sessionsWhere: Prisma.DriverOnlineSessionWhereInput = {
    OR: [{ driverUserId: D }, { startedAt: { lt: before }, ...notDemoDriver }],
  };
  const trailWhere: Prisma.DriverLocationPointWhereInput = {
    OR: [{ driverUserId: D }, { recordedAt: { lt: before }, ...notDemoDriver }],
  };
  const codeWhere = { OR: [{ phone: { in: deletedPhones } }, { createdAt: { lt: before }, phone: { notIn: keptPhoneSet } }] };

  const where = {
    rides: { id: R },
    passengers: { OR: [{ rideId: R }, { riderId: D }] },
    offers: { OR: [{ rideId: R }, { driverUserId: D }] },
    rejections: { OR: [{ rideId: R }, { driverUserId: D }] },
    ratings: { OR: [{ rideId: R }, { raterId: D }, { rateeId: D }] },
    ridePayments: { OR: [{ rideId: R }, { riderId: D }] },
    sos: { OR: [{ rideId: R }, { riderId: D }] },
    trackingLinks: { OR: [{ rideId: R }, { riderId: D }] },
    ledger: { OR: [{ rideId: R }, { driverUserId: D }] },
    cash: { id: { in: cashIds } },
    paystack: { id: { in: paystackIds } },
    sessions: sessionsWhere,
    trail: trailWhere,
    otp: codeWhere,
    demoOtp: codeWhere,
    drivers: { userId: D },
    refreshTokens: { userId: D },
    pushTokens: { userId: D },
    passkeys: { userId: D },
    closedAccounts: { userId: D },
    users: { id: D },
  };

  // Photos: only deleted drivers', and only from the Cloudinary account we were given.
  const photos: PhotoTarget[] = [];
  const photoProblems: PhotoProblem[] = [];
  for (const u of doomed) {
    const urls = [u.driver?.photoUrl, u.accountDeletion?.keptPhotoUrl].filter((x): x is string => !!x);
    const ids = new Set<string>();
    for (const url of urls) {
      const parsed = parseCloudinaryUrl(url);
      if (!parsed) {
        photoProblems.push({ phone: u.phone, what: "photo link isn't a Cloudinary image: left alone" });
      } else if (parsed.cloudName !== options.cloudName) {
        photoProblems.push({
          phone: u.phone,
          what: `photo is in Cloudinary account "${parsed.cloudName}", not "${options.cloudName || "(none set)"}": left alone`,
        });
      } else {
        ids.add(parsed.publicId);
        ids.add(driverPhotoPublicId(u.id));
      }
    }
    for (const publicId of ids) photos.push({ userId: u.id, phone: u.phone, publicId });
  }

  return { where, kept, photos, photoProblems, deletedCount: deletedIds.length };
}

/** Counts per table for `collect`'s filters, in the order a reader thinks of them. */
async function countAll(db: Db, w: Awaited<ReturnType<typeof collect>>["where"]) {
  const rows: Array<[string, Promise<number>]> = [
    ["Accounts (riders and drivers)", db.user.count({ where: w.users })],
    ["  driver records (car, photo, approval)", db.driver.count({ where: w.drivers })],
    ["  sessions (refresh tokens)", db.refreshToken.count({ where: w.refreshTokens })],
    ["  push tokens", db.pushToken.count({ where: w.pushTokens })],
    ["  passkeys", db.adminPasskey.count({ where: w.passkeys })],
    ["  closed-account records", db.accountDeletion.count({ where: w.closedAccounts })],
    ["  login codes (app)", db.otpCode.count({ where: w.otp })],
    ["  login codes (demo site)", db.demoOtp.count({ where: w.demoOtp })],
    ["Rides", db.ride.count({ where: w.rides })],
    ["  seats (ride passengers)", db.ridePassenger.count({ where: w.passengers })],
    ["  offers to drivers", db.rideOffer.count({ where: w.offers })],
    ["  driver rejections", db.rideRejection.count({ where: w.rejections })],
    ["  ratings", db.rating.count({ where: w.ratings })],
    ["  ride payments (Moolre)", db.payment.count({ where: w.ridePayments })],
    ["  SOS records", db.sosEvent.count({ where: w.sos })],
    ["  SOS tracking links", db.trackingLink.count({ where: w.trackingLinks })],
    ["Finances: commission owed (ledger)", db.commissionLedger.count({ where: w.ledger })],
    ["  payments, waivers, adjustments", db.driverCashPayment.count({ where: w.cash })],
    ["  Paystack payment attempts", db.driverPaystackPayment.count({ where: w.paystack })],
    ["Driver online sessions", db.driverOnlineSession.count({ where: w.sessions })],
    ["Driver location points", db.driverLocationPoint.count({ where: w.trail })],
  ];
  const counts = await Promise.all(rows.map(([, n]) => n));
  return rows.map(([label], i) => ({ label, rows: counts[i]! }));
}

/** The dry run: what a reset would delete and keep. Writes nothing. */
export async function planReset(db: PrismaClient, options: ResetOptions): Promise<ResetPlan> {
  const c = await collect(db, options);
  return { counts: await countAll(db, c.where), kept: c.kept, photos: c.photos, photoProblems: c.photoProblems };
}

export interface ResetResult extends ResetPlan {
  photoFailures: PhotoProblem[];
}

/**
 * The real run. Every database delete is in one transaction, in an order the
 * foreign keys accept (nothing is left pointing at a deleted row); the
 * Cloudinary photos go only after it has committed.
 */
export async function applyReset(
  db: PrismaClient,
  options: ResetOptions,
  destroy: (publicId: string) => Promise<{ ok: boolean; reason?: string }> = (id) => destroyCloudinaryImage(id),
): Promise<ResetResult> {
  const plan = await db.$transaction(async (tx) => {
    const c = await collect(tx, options);
    const counts = await countAll(tx, c.where);
    const w = c.where;
    // Children of rides and accounts that would block (RESTRICT) or that we count.
    await tx.rideOffer.deleteMany({ where: w.offers });
    await tx.rideRejection.deleteMany({ where: w.rejections });
    await tx.rating.deleteMany({ where: w.ratings });
    await tx.payment.deleteMany({ where: w.ridePayments });
    await tx.sosEvent.deleteMany({ where: w.sos });
    await tx.trackingLink.deleteMany({ where: w.trackingLinks });
    await tx.ridePassenger.deleteMany({ where: w.passengers });
    await tx.commissionLedger.deleteMany({ where: w.ledger });
    // Reversals before what they reverse; credits before their Paystack attempt.
    for (let guard = 0; ; guard += 1) {
      const removed = await tx.driverCashPayment.deleteMany({ where: { ...w.cash, reversal: { is: null } } });
      const left = await tx.driverCashPayment.count({ where: w.cash });
      if (left === 0) break;
      if (removed.count === 0 || guard > 20) throw new Error("Couldn't untangle payment reversals: nothing was changed.");
    }
    await tx.driverPaystackPayment.deleteMany({ where: w.paystack });
    await tx.ride.deleteMany({ where: w.rides });
    await tx.driverOnlineSession.deleteMany({ where: w.sessions });
    await tx.driverLocationPoint.deleteMany({ where: w.trail });
    await tx.otpCode.deleteMany({ where: w.otp });
    await tx.demoOtp.deleteMany({ where: w.demoOtp });
    await tx.refreshToken.deleteMany({ where: w.refreshTokens });
    await tx.pushToken.deleteMany({ where: w.pushTokens });
    await tx.adminPasskey.deleteMany({ where: w.passkeys });
    await tx.accountDeletion.deleteMany({ where: w.closedAccounts });
    await tx.driver.deleteMany({ where: w.drivers });
    await tx.user.deleteMany({ where: w.users });
    await tx.adminAuditLog.create({
      data: {
        actor: "script:resetTestData",
        action: "data.reset",
        target: "database",
        reason:
          `Pre-launch reset, everything before ${options.before.toISOString()}: ` +
          counts
            .filter((r) => r.rows > 0 && !r.label.startsWith(" "))
            .map((r) => `${r.rows} ${r.label.toLowerCase()}`)
            .join(", "),
      },
    });
    return { counts, kept: c.kept, photos: c.photos, photoProblems: c.photoProblems };
  }, SCRIPT_TX_OPTIONS);

  const photoFailures: PhotoProblem[] = [];
  for (const photo of plan.photos) {
    const result = await destroy(photo.publicId);
    if (!result.ok) photoFailures.push({ phone: photo.phone, what: `${photo.publicId}: ${result.reason ?? "failed"}` });
  }
  return { ...plan, photoFailures };
}

/** "ep-empty-violet-bay5yr3y" from a Neon host (the -pooler suffix dropped); the host itself otherwise. */
export function endpointId(host: string): string {
  return (host.split(".")[0] ?? host).replace(/-pooler$/, "");
}

function printPlan(plan: ResetPlan): void {
  console.log("\nRows deleted:");
  for (const { label, rows } of plan.counts) console.log(`  ${String(rows).padStart(8)}  ${label}`);
  console.log(`  ${String(plan.photos.length).padStart(8)}  Cloudinary photos (after the database commit)`);

  console.log(`\nAccounts kept (${plan.kept.length}):`);
  const shown = plan.kept.filter((k) => k.why !== "created after the cutoff");
  const later = plan.kept.filter((k) => k.why === "created after the cutoff");
  for (const k of [...shown, ...later.slice(0, 50)]) {
    console.log(`  ${maskPhone(k.phone).padEnd(14)} ${k.role.padEnd(7)} ${k.why}`);
  }
  if (later.length > 50) console.log(`  …and ${later.length - 50} more created after the cutoff`);
  if (plan.photoProblems.length > 0) {
    console.log("\nPhotos left alone:");
    for (const p of plan.photoProblems) console.log(`  ${maskPhone(p.phone).padEnd(14)} ${p.what}`);
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  const host = dbHostFromUrl(url) ?? "(unknown)";
  console.log(`Database endpoint: ${endpointId(host)}${KNOWN_PROD_DB_HOSTS.some((p) => host.includes(p)) ? "  ← PRODUCTION" : ""}`);
  assertProductionOptIn(url, "reset-test-data");

  const { options, confirm } = parseArgs(process.argv.slice(2));
  const full: ResetOptions = { ...options, demoPhones: demoPhonesFromEnv(), cloudName: config.cloudinary.cloudName };
  console.log(`Cutoff: accounts, rides and money rows created before ${options.before.toISOString()}`);
  console.log(`Cloudinary account: ${config.cloudinary.cloudName || "(none set: photos will be listed as failures)"}`);
  console.log(confirm ? "Mode: REAL RUN — deleting" : `Mode: DRY RUN — nothing is written (add --confirm=${CONFIRM_WORD} to delete)`);

  if (!confirm) {
    printPlan(await planReset(prisma, full));
    return;
  }
  const result = await applyReset(prisma, full);
  printPlan(result);
  console.log("\nDatabase: committed.");
  if (result.photoFailures.length === 0) console.log(`Cloudinary: ${result.photos.length} photo(s) deleted.`);
  else {
    console.log(`Cloudinary: ${result.photos.length - result.photoFailures.length} deleted, ${result.photoFailures.length} failed:`);
    for (const f of result.photoFailures) console.log(`  ${maskPhone(f.phone).padEnd(14)} ${f.what}`);
  }
  console.log("\nNow restart the server (Render → Manual Deploy → Restart service) to clear its in-memory state.");
}

if (require.main === module) {
  main()
    .catch((err: unknown) => {
      console.error(`\nreset-test-data: ${redactText(err instanceof Error ? err.message : String(err))}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
