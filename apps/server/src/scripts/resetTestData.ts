/**
 * One-off, before the public launch: clears the test trips and money so the
 * apps and the admin site start from zero. Two modes; you must name one.
 *
 * --trips-only (THE ONE TO USE: real people are already signing up)
 *
 *   # 1. DRY RUN (the default — prints counts, writes nothing)
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run reset:test-data -- --trips-only --before=2026-11-16T00:00:00Z
 *
 *   # 2. The real run: the same, plus --confirm=RESET-TRIPS
 *
 *   Deletes, for rows from before --before, never the review demo's:
 *   - every ride, with its seats (each rider's stops, pins and fare live on
 *     the seat), offers, rejections, ratings, ride payments, SOS records and
 *     SOS tracking links;
 *   - every commission owed (ledger), payment, waiver, adjustment and
 *     Paystack payment attempt (Finances back to zero);
 *   - driver online sessions and location trails.
 *   Never deletes or changes an account: user rows, driver records (approval,
 *   car, photo), Cloudinary, emergency contacts, early access, sessions, push
 *   tokens, passkeys, settings, zones, places, notification history and the
 *   audit log are untouched. Accounts hold no figures worked out from rides
 *   (ratings, ride counts, earnings and balances are computed from the rows
 *   above whenever they're shown), so there is nothing on them to reset:
 *   with the rows gone, every rider and driver reads as brand new.
 *
 * --delete-accounts (the old full reset: ALSO deletes accounts; don't use
 * it now that real people have signed up)
 *
 *   ALLOW_PRODUCTION_DB=1 DATABASE_URL="$PROD_URL" DIRECT_URL="$PROD_URL" \
 *     npm run reset:test-data -- --delete-accounts --before=2026-11-16T00:00:00Z --keep=+233241234567
 *   (real run: --confirm=RESET-CAMPUSRIDE)
 *
 *   KEPT, always:
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
 *   DELETED:
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
 * Rate limits, positions and admin figures live in the server's memory, not
 * the database: restart the server afterwards (Render → Manual Deploy →
 * Restart service) to clear them.
 *
 * SAFETY: dry run unless --confirm has the mode's word (RESET-TRIPS or
 * RESET-CAMPUSRIDE; each refuses the other). A known production database is
 * refused without ALLOW_PRODUCTION_DB=1, and the database's endpoint id is
 * printed before anything else. All database deletes are one transaction
 * (all or nothing); --trips-only also rolls back if the number of accounts
 * changed. Cloudinary (--delete-accounts only) runs only after the commit,
 * and only for photos stored in the Cloudinary account the script was given;
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

/** --delete-accounts' confirm word. */
export const CONFIRM_WORD = "RESET-CAMPUSRIDE";
/** --trips-only's confirm word. */
export const TRIPS_CONFIRM_WORD = "RESET-TRIPS";

export type ResetMode = "trips-only" | "delete-accounts";

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

const USAGE =
  `Use --trips-only (or --delete-accounts), --before=<ISO time>, and --confirm=${TRIPS_CONFIRM_WORD} for a real run.`;

/** "--trips-only --before=…" etc. Throws, in words, on anything it doesn't know or can't use. */
export function parseArgs(
  argv: readonly string[],
  now = new Date(),
): { mode: ResetMode; options: Omit<ResetOptions, "demoPhones" | "cloudName">; confirm: boolean } {
  const flags = new Set(["--trips-only", "--delete-accounts"]);
  const known = new Set(["--before", "--keep", "--confirm"]);
  const values = new Map<string, string>();
  const modes: ResetMode[] = [];
  for (const arg of argv) {
    if (flags.has(arg)) {
      modes.push(arg === "--trips-only" ? "trips-only" : "delete-accounts");
      continue;
    }
    const [name, ...value] = arg.split("=");
    if (!name || !known.has(name) || value.length === 0) throw new Error(`Unknown argument "${name ?? arg}". ${USAGE}`);
    values.set(name, value.join("="));
  }
  const mode = modes[0];
  if (!mode) throw new Error(`Say which reset: --trips-only (rides and money only; accounts are never touched). ${USAGE}`);
  if (modes.length > 1 && modes.some((m) => m !== mode)) throw new Error("Pick one of --trips-only and --delete-accounts, not both.");
  const rawBefore = values.get("--before");
  if (!rawBefore) throw new Error("--before=<ISO time> is required, e.g. --before=2026-11-16T00:00:00Z.");
  const before = new Date(rawBefore);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(rawBefore) || Number.isNaN(before.getTime())) {
    throw new Error(`--before must be an ISO time like 2026-11-16T00:00:00Z.`);
  }
  if (before.getTime() > now.getTime()) throw new Error("--before is in the future: pick a time that has passed.");
  if (mode === "trips-only" && values.has("--keep")) {
    throw new Error("--keep is for --delete-accounts only: --trips-only never deletes an account.");
  }
  const keepPhones = (values.get("--keep") ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const phone of keepPhones) {
    if (normalizePhone(phone) !== phone) {
      throw new Error(`--keep has ${maskPhone(phone)}, which isn't in the canonical +233XXXXXXXXX form.`);
    }
  }
  const word = mode === "trips-only" ? TRIPS_CONFIRM_WORD : CONFIRM_WORD;
  const confirmValue = values.get("--confirm");
  if (confirmValue !== undefined && confirmValue !== word) {
    throw new Error(`--confirm for --${mode} must be exactly ${word}.`);
  }
  return { mode, options: { before, keepPhones }, confirm: confirmValue === word };
}

/** The review demo numbers from the environment, canonical, whether or not the demo is switched on. */
export function demoPhonesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.REVIEW_DEMO_RIDER_PHONE, env.REVIEW_DEMO_DRIVER_PHONE]
    .map((p) => normalizePhone(p ?? ""))
    .filter((p): p is string => p !== null);
}

/**
 * The Paystack attempts and payment/waiver/adjustment rows matching any of
 * `match`, plus the credits for those attempts and the reversals of those
 * rows: a credit or reversal can't outlive what it points at (foreign key).
 */
async function moneyIds(db: Db, match: Array<{ driverUserId: Prisma.StringFilter; createdAt?: Prisma.DateTimeFilter }>) {
  const paystackIds = (await db.driverPaystackPayment.findMany({ where: { OR: match }, select: { id: true } })).map((p) => p.id);
  let cashIds = (
    await db.driverCashPayment.findMany({
      where: { OR: [...match, { paystackPaymentId: { in: paystackIds } }] },
      select: { id: true },
    })
  ).map((c) => c.id);
  for (let added = true; added; ) {
    const more = await db.driverCashPayment.findMany({
      where: { reversesId: { in: cashIds }, id: { notIn: cashIds } },
      select: { id: true },
    });
    cashIds = [...cashIds, ...more.map((c) => c.id)];
    added = more.length > 0;
  }
  return { paystackIds, cashIds };
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
  const { paystackIds, cashIds } = await moneyIds(db, [
    { driverUserId: D },
    { createdAt: { lt: before }, driverUserId: { notIn: demoUserIds } },
  ]);
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

/** Reversals before what they reverse; credits before their Paystack attempt. */
async function deleteMoney(
  tx: Prisma.TransactionClient,
  cash: Prisma.DriverCashPaymentWhereInput,
  paystack: Prisma.DriverPaystackPaymentWhereInput,
): Promise<void> {
  for (let guard = 0; ; guard += 1) {
    const removed = await tx.driverCashPayment.deleteMany({ where: { ...cash, reversal: { is: null } } });
    const left = await tx.driverCashPayment.count({ where: cash });
    if (left === 0) break;
    if (removed.count === 0 || guard > 20) throw new Error("Couldn't untangle payment reversals: nothing was changed.");
  }
  await tx.driverPaystackPayment.deleteMany({ where: paystack });
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
    await deleteMoney(tx, w.cash, w.paystack);
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

// ─── --trips-only ──────────────────────────────────────────────────────────

export interface TripsResetOptions {
  /** Rides, money rows, online sessions and location points created before this are deleted. */
  before: Date;
  /** The review demo numbers (REVIEW_DEMO_RIDER_PHONE / _DRIVER_PHONE), protected even if the demo is off. */
  demoPhones: readonly string[];
}

export interface TripsResetPlan {
  /** Rows per table (or category) that a real run deletes. */
  counts: Array<{ label: string; rows: number }>;
  /** Of the rides, how many are still open (not completed or cancelled). */
  openRides: number;
  /** Accounts in the database: none is deleted or changed. */
  users: number;
  usersDeleted: 0;
  usersModified: 0;
}

/**
 * What accounts show that comes from rides, and where it comes from: all of
 * it is worked out from the rows --trips-only deletes whenever it's shown, so
 * nothing is stored on an account to reset.
 */
export const COMPUTED_FROM_RIDES = [
  "ride counts and trip history (rides, seats)",
  "rating averages and counts (ratings)",
  "earnings and fares (rides, seats)",
  "commission owed, paid and balance (ledger, payments, waivers, adjustments)",
  "online hours and acceptance rates (online sessions, offers, rejections)",
] as const;

/** The review demo's accounts: never touched, nor any ride or row of theirs. */
async function demoUserIdsIn(db: Db, demoPhones: readonly string[]): Promise<string[]> {
  const demo = await db.user.findMany({
    where: { OR: [{ isReviewDemo: true }, { phone: { in: [...demoPhones] } }] },
    select: { id: true },
  });
  return demo.map((u) => u.id);
}

async function collectTrips(db: Db, options: TripsResetOptions) {
  const { before } = options;
  const demoIds = await demoUserIdsIn(db, options.demoPhones);
  const notDemo = { notIn: demoIds };
  const rideIds = (
    await db.ride.findMany({
      where: {
        isReviewDemo: false,
        createdAt: { lt: before },
        riderId: notDemo,
        OR: [{ driverId: null }, { driverId: notDemo }],
        passengers: { none: { riderId: { in: demoIds } } },
      },
      select: { id: true },
    })
  ).map((r) => r.id);
  const R = { rideId: { in: rideIds } };
  const { paystackIds, cashIds } = await moneyIds(db, [{ createdAt: { lt: before }, driverUserId: notDemo }]);
  return {
    rides: { id: { in: rideIds } },
    passengers: R,
    offers: R,
    rejections: R,
    ratings: R,
    ridePayments: R,
    sos: R,
    trackingLinks: R,
    ledger: R,
    cash: { id: { in: cashIds } },
    paystack: { id: { in: paystackIds } },
    sessions: { startedAt: { lt: before }, driverUserId: notDemo },
    trail: { recordedAt: { lt: before }, driverUserId: notDemo },
  } satisfies Record<string, object>;
}

async function countTrips(db: Db, w: Awaited<ReturnType<typeof collectTrips>>) {
  const rows: Array<[string, Promise<number>]> = [
    ["Rides", db.ride.count({ where: w.rides })],
    ["  seats (each rider's stops, pins and fare)", db.ridePassenger.count({ where: w.passengers })],
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
  const [counts, openRides, users] = await Promise.all([
    Promise.all(rows.map(([, n]) => n)),
    db.ride.count({ where: { ...w.rides, status: { notIn: ["COMPLETED", "CANCELLED"] } } }),
    db.user.count(),
  ]);
  return {
    counts: rows.map(([label], i) => ({ label, rows: counts[i]! })),
    openRides,
    users,
    usersDeleted: 0 as const,
    usersModified: 0 as const,
  };
}

/** The --trips-only dry run: what it would delete. Writes nothing. */
export async function planTripsReset(db: PrismaClient, options: TripsResetOptions): Promise<TripsResetPlan> {
  return countTrips(db, await collectTrips(db, options));
}

/**
 * The --trips-only real run, in one transaction. Accounts are never written;
 * if one that was there at the start is gone at the end anyway, everything
 * rolls back. (Someone signing up meanwhile is fine.)
 */
export async function applyTripsReset(db: PrismaClient, options: TripsResetOptions): Promise<TripsResetPlan> {
  return db.$transaction(async (tx) => {
    const userIds = (await tx.user.findMany({ select: { id: true } })).map((u) => u.id);
    const w = await collectTrips(tx, options);
    const plan = await countTrips(tx, w);
    await tx.rideOffer.deleteMany({ where: w.offers });
    await tx.rideRejection.deleteMany({ where: w.rejections });
    await tx.rating.deleteMany({ where: w.ratings });
    await tx.payment.deleteMany({ where: w.ridePayments });
    await tx.sosEvent.deleteMany({ where: w.sos });
    await tx.trackingLink.deleteMany({ where: w.trackingLinks });
    await tx.ridePassenger.deleteMany({ where: w.passengers });
    await tx.commissionLedger.deleteMany({ where: w.ledger });
    await deleteMoney(tx, w.cash, w.paystack);
    await tx.ride.deleteMany({ where: w.rides });
    await tx.driverOnlineSession.deleteMany({ where: w.sessions });
    await tx.driverLocationPoint.deleteMany({ where: w.trail });
    const stillThere = await tx.user.count({ where: { id: { in: userIds } } });
    if (stillThere !== userIds.length) {
      throw new Error(`${userIds.length - stillThere} account(s) would have gone: nothing was changed.`);
    }
    await tx.adminAuditLog.create({
      data: {
        actor: "script:resetTestData",
        action: "data.reset.trips",
        target: "database",
        reason:
          `Pre-launch trips reset, everything before ${options.before.toISOString()} (no account deleted or changed): ` +
          (plan.counts
            .filter((r) => r.rows > 0 && !r.label.startsWith(" "))
            .map((r) => `${r.rows} ${r.label.toLowerCase()}`)
            .join(", ") || "nothing to delete"),
      },
    });
    return plan;
  }, SCRIPT_TX_OPTIONS);
}

function printTripsPlan(plan: TripsResetPlan): void {
  console.log("\nRows deleted:");
  for (const { label, rows } of plan.counts) console.log(`  ${String(rows).padStart(8)}  ${label}`);
  if (plan.openRides > 0) {
    console.log(`\n  Note: ${plan.openRides} of these rides are still open (not completed or cancelled); they vanish from the apps.`);
  }
  console.log(`\nUsers deleted: ${plan.usersDeleted}, users modified: ${plan.usersModified} (no fields reset)`);
  console.log(`  ${plan.users} accounts in the database, all kept as they are. Nothing is stored on an account from rides;`);
  console.log(`  these are worked out from the rows above, so they start again from zero:`);
  for (const what of COMPUTED_FROM_RIDES) console.log(`    - ${what}`);
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

  const { mode, options, confirm } = parseArgs(process.argv.slice(2));
  if (mode === "trips-only") {
    const trips: TripsResetOptions = { before: options.before, demoPhones: demoPhonesFromEnv() };
    console.log(`Mode: --trips-only. Cutoff: rides, money rows, online sessions and location points created before ${options.before.toISOString()}`);
    console.log("Accounts: never deleted or changed. Cloudinary: not used.");
    console.log(confirm ? "REAL RUN — deleting" : `DRY RUN — nothing is written (add --confirm=${TRIPS_CONFIRM_WORD} to delete)`);
    if (!confirm) {
      printTripsPlan(await planTripsReset(prisma, trips));
      return;
    }
    printTripsPlan(await applyTripsReset(prisma, trips));
    console.log("\nDatabase: committed.");
    console.log("\nNow restart the server (Render → Manual Deploy → Restart service) to clear its in-memory state.");
    return;
  }

  const full: ResetOptions = { ...options, demoPhones: demoPhonesFromEnv(), cloudName: config.cloudinary.cloudName };
  console.log("Mode: --delete-accounts (ALSO DELETES ACCOUNTS)");
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
