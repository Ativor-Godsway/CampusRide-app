import dotenv from "dotenv";
import path from "node:path";
import { resolveCloudinaryConfig } from "./services/uploads/cloudinaryConfig";
import { normalizePhone } from "./lib/phone";
import { resolveAppMinVersions } from "./lib/appMinVersions";
import { ACCOUNT_DELETION_RETENTION_DAYS } from "@rida/shared";

// Per-environment .env loading (dev/test/prod split — see docs/environments.md).
// NODE_ENV picks the file: `.env.development` (default), `.env.test` (vitest
// sets NODE_ENV=test), or none in production (Render injects real env vars, and
// no .env* file is deployed). We load the env-specific file FIRST, then `.env`
// as a fallback — dotenv never overrides an already-set var, so the specific
// file and any real process env (Render) both win over the base `.env`. This is
// what keeps local dev/tests OFF the production database.
const NODE_ENV = process.env.NODE_ENV ?? "development";
const serverRoot = path.resolve(__dirname, "..");
// `.env.development.local` (gitignored, optional) wins over
// `.env.development`: put a local Postgres URL there to run against this
// Mac's database instead of the dev branch (docs/testing/SOLO_TESTING.md).
// Never read under the test suite, which has its own database.
if (NODE_ENV !== "test") dotenv.config({ path: path.join(serverRoot, `.env.${NODE_ENV}.local`) });
dotenv.config({ path: path.join(serverRoot, `.env.${NODE_ENV}`) });
dotenv.config({ path: path.join(serverRoot, ".env") });

export const APP_NAME = "CampusRide";

/** A positive whole number from the environment, or the default when unset or not valid. */
function positive(name: string, fallback: number): number {
  return positiveInt(process.env[name], fallback);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * How much looser every rate limit is: 10x by default in development and
 * test (RATE_LIMIT_MULTIPLIER changes it), and ALWAYS 1 in production — no
 * setting can loosen production's limits by accident.
 */
export function rateLimitMultiplier(nodeEnv: string, raw: string | undefined): number {
  return nodeEnv === "production" ? 1 : positiveInt(raw, 10);
}

export interface PhoneList {
  /** Canonical "+233…" numbers. */
  phones: string[];
  /** Entries that aren't a Ghanaian number (a typo): production refuses to boot with any. */
  invalid: string[];
}

/** "0241234567, +233 54 860 8146" -> canonical numbers, in any spelling, comma or space separated. */
export function parsePhoneList(raw: string | undefined): PhoneList {
  const entries = (raw ?? "")
    .split(/[,;\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
  const phones: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const phone = normalizePhone(entry);
    if (phone) {
      if (!phones.includes(phone)) phones.push(phone);
    } else invalid.push(entry);
  }
  return { phones, invalid };
}

/**
 * First value that is set AND not blank. `??` alone is wrong for the CORS
 * fallback: a var set to "" in a dashboard is not null/undefined, so it would
 * shadow the legacy name with an empty allowlist rather than falling through.
 */
function firstNonBlank(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value;
  }
  return "";
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: process.env.JWT_SECRET ?? "",
  /**
   * The only phone numbers that may use the admin site, even if an account's
   * role is ADMIN in the database (Stage 3). Comma-separated, any spelling.
   * In production an empty list means NOBODY gets in (and the server won't
   * boot without one: lib/productionEnv.ts); elsewhere it means any ADMIN.
   */
  adminPhoneAllowlist: parsePhoneList(process.env.ADMIN_PHONE_ALLOWLIST),
  /**
   * Admin sessions are short (services/auth/authService.ts): the admin site
   * holds a 10-minute access token, renewed while it's in use; 30 minutes
   * without using it signs it out, and nothing lasts past 8 hours from the
   * login. Rider and driver sessions are unchanged.
   */
  adminSession: {
    accessTokenMinutes: Math.min(60, positive("ADMIN_ACCESS_TOKEN_MINUTES", 10)),
    idleMinutes: Math.min(240, positive("ADMIN_IDLE_MINUTES", 30)),
    maxHours: Math.min(24, positive("ADMIN_SESSION_MAX_HOURS", 8)),
  },
  mnotify: {
    enabled: process.env.MNOTIFY_ENABLED === "true",
    apiKey: process.env.MNOTIFY_API_KEY ?? "",
    senderId: process.env.MNOTIFY_SENDER_ID ?? "CampusRide",
  },
  moolre: {
    /**
     * Phase 2: the single MOOLRE_ENABLED flag used to gate payments AND SMS
     * together, which made "OTP by real SMS while payments stay off"
     * impossible. It is now split in two. Both fall back to the legacy
     * MOOLRE_ENABLED only when the specific var is unset, so an old
     * environment keeps its exact previous behaviour.
     */
    /** Collections/disbursements + the Moolre webhook. OFF for the cash-only launch. */
    paymentsEnabled: (process.env.MOOLRE_PAYMENTS_ENABLED ?? process.env.MOOLRE_ENABLED) === "true",
    /** Moolre SMS (VAS) transport — OTP delivery and USSD notifications. Independent of payments. */
    smsEnabled: (process.env.MOOLRE_SMS_ENABLED ?? process.env.MOOLRE_ENABLED) === "true",
    // sandbox.moolre.com for now, api.moolre.com for live — config-driven, never hardcoded.
    baseUrl: process.env.MOOLRE_BASE_URL ?? "https://sandbox.moolre.com",
    apiUser: process.env.MOOLRE_API_USER ?? "",
    publicKey: process.env.MOOLRE_PUBLIC_KEY ?? "",
    /** Most sensitive secret in the system — moves money out (transfers). Never log. */
    privateKey: process.env.MOOLRE_PRIVATE_KEY ?? "",
    accountNumber: process.env.MOOLRE_ACCOUNT_NUMBER ?? "",
    webhookSecret: process.env.MOOLRE_WEBHOOK_SECRET ?? "",
    /** X-API-VASKEY header — SMS (VAS) calls only. Separate from the payment keys. Never log. */
    vasKey: process.env.MOOLRE_VAS_KEY ?? "",
    /** Sender ID for SMS, must be pre-registered and approved with Moolre. */
    smsSenderId: process.env.MOOLRE_SMS_SENDER_ID ?? "",
    /** Warn (Sentry + logs) when the SMS balance drops below this (services/sms/moolreBalance.ts). */
    smsLowBalance: positive("MOOLRE_SMS_LOW_BALANCE", 100),
  },
  /** A ride still IN_PROGRESS after this many hours is completed by the sweep (services/ride/staleRides.ts). 1–24. */
  rideAutoCompleteHours: Math.min(24, positive("RIDE_AUTO_COMPLETE_HOURS", 3)),
  /**
   * How long a closed account's kept details (name, phone, a driver's plate
   * and photo — for safety disputes) are held before they are erased, with
   * the person's notes, exact pins and rating comments. 1–365, default 90.
   */
  accountDeletionRetentionDays: Math.min(365, positive("ACCOUNT_DELETION_RETENTION_DAYS", ACCOUNT_DELETION_RETENTION_DAYS)),
  /**
   * Rate limits (src/rateLimit). Each one is counted per PERSON — the phone
   * number before login, the account after — with the client's IP only as a
   * generous backstop on routes nobody is signed in to. Every number can be
   * changed on Render without a redeploy of code; the windows are fixed.
   * docs/security/rate-limits.md explains each one.
   */
  rateLimit: {
    /**
     * Every maximum is multiplied by this outside production (default 10),
     * so local work and the test suite never trip a limit by accident.
     * Production always uses the real numbers, whatever this says.
     */
    multiplier: rateLimitMultiplier(NODE_ENV, process.env.RATE_LIMIT_MULTIPLIER),

    // Login codes, per phone number.
    /** Seconds between two codes to the same number (the app's "Resend code" countdown). */
    otpCooldownSeconds: positive("RATE_LIMIT_OTP_COOLDOWN_SECONDS", 60),
    otpSendPer15Min: positive("RATE_LIMIT_OTP_SEND_15M", 5),
    otpSendPer24h: positive("RATE_LIMIT_OTP_SEND_24H", 10),
    /** Code checks per number (on top of 5 wrong tries burning a code). */
    otpVerifyPer15Min: positive("RATE_LIMIT_OTP_VERIFY_15M", 10),
    /** The same, stricter, for a number that belongs to an ADMIN account. */
    adminOtpSendPer15Min: positive("RATE_LIMIT_ADMIN_OTP_SEND_15M", 3),
    adminOtpSendPer24h: positive("RATE_LIMIT_ADMIN_OTP_SEND_24H", 6),
    adminOtpVerifyPer15Min: positive("RATE_LIMIT_ADMIN_OTP_VERIFY_15M", 5),
    /** Sign-ups and log-ins per number. */
    loginPer15Min: positive("RATE_LIMIT_LOGIN_15M", 10),
    /** Token refreshes per login (one rotation chain) and per account. */
    refreshPerSession15Min: positive("RATE_LIMIT_REFRESH_SESSION_15M", 10),
    refreshPerUser15Min: positive("RATE_LIMIT_REFRESH_USER_15M", 30),

    // Signed-in routes, per account.
    /** Any signed-in route without a tighter limit of its own. The busiest screen makes ~30 a minute. */
    userPerMinute: positive("RATE_LIMIT_USER_PER_MINUTE", 120),
    rideCreatePerHour: positive("RATE_LIMIT_RIDE_CREATE_HOUR", 12),
    rideCancelPerHour: positive("RATE_LIMIT_RIDE_CANCEL_HOUR", 12),
    rideSwitchPer15Min: positive("RATE_LIMIT_RIDE_SWITCH", 10),
    driverAcceptPer15Min: positive("RATE_LIMIT_DRIVER_ACCEPT_15M", 60),
    driverDeclinePer15Min: positive("RATE_LIMIT_DRIVER_DECLINE_15M", 120),
    ratingPerHour: positive("RATE_LIMIT_RATING_HOUR", 20),
    profilePerHour: positive("RATE_LIMIT_PROFILE_HOUR", 20),
    pushTokenPer15Min: positive("RATE_LIMIT_PUSH_TOKEN_15M", 30),
    /** Each authorizes a write into our Cloudinary account. */
    uploadPerHour: positive("RATE_LIMIT_UPLOAD_HOUR", 10),
    accountDeletePerHour: positive("RATE_LIMIT_ACCOUNT_DELETE_HOUR", 5),
    /** POST /routes/legs — each may call OSRM. */
    routeLegsPer15Min: positive("RATE_LIMIT_ROUTE_LEGS", 120),
    /** POST /rides/:id/initiate-payment — each hits Moolre. */
    paymentInitPer15Min: positive("RATE_LIMIT_PAYMENT_INIT", 15),

    // Everything else.
    /** GET /track/:token, per link. The page refreshes itself every 15 s. */
    trackPerLinkPer15Min: positive("RATE_LIMIT_TRACK_15M", 120),
    /**
     * SOS is never refused. A repeat press on the same ride within this many
     * minutes doesn't text the same people again (SMS costs money); the
     * first always goes out.
     */
    sosRepeatSmsMinutes: positive("RATE_LIMIT_SOS_REPEAT_MINUTES", 2),
    /** Driver GPS over the socket: at most one relayed per this many seconds per driver; extras are dropped. */
    driverLocationSeconds: positive("RATE_LIMIT_DRIVER_LOCATION_SECONDS", 2),
    /** Socket ride subscriptions per account. */
    socketSubscribePerMinute: positive("RATE_LIMIT_SOCKET_SUBSCRIBE_MINUTE", 60),
    /** USSD keypresses per subscriber (dormant while ENABLE_USSD is off). */
    ussdPerSubscriberPerMinute: positive("RATE_LIMIT_USSD_MINUTE", 30),

    // The IP backstop: only on routes nobody is signed in to, high enough
    // that a whole hostel on one Wi-Fi never meets it.
    ipPublicPer15Min: positive("RATE_LIMIT_IP_PUBLIC_15M", 1000),
    /** Login codes sent from one IP to any numbers: stops a bot texting every number in Ghana on our credit. */
    ipOtpSendPer15Min: positive("RATE_LIMIT_IP_OTP_SEND_15M", 200),
  },
  /**
   * Selects the OTP delivery provider. One of "moolre" | "mnotify" | "dummy".
   * Precedence (see services/active.ts):
   *   - "moolre"  -> MoolreOtpService, only if moolre.smsEnabled AND vasKey/smsSenderId set.
   *   - "mnotify" -> MnotifyOtpService, only if mnotify.enabled.
   *   - anything else (incl. unset/"dummy") -> DummyOtpService (default for tests/dev).
   * If the requested provider's prerequisites aren't met, falls back to DummyOtpService.
   */
  otpProvider: process.env.OTP_PROVIDER ?? "dummy",
  /**
   * Comma-separated browser origins allowed to call the public demo OTP routes
   * (e.g. the showcase site). When empty, CORS reflects any origin (the prior
   * default). Native apps send no Origin header and are unaffected. See index.ts.
   */
  demoOtpCorsOrigins: process.env.DEMO_OTP_CORS_ORIGINS ?? "",
  /**
   * Comma-separated browser origins allowed to call the API at all (CORS).
   * Falls back to DEMO_OTP_CORS_ORIGINS, which previously served this role.
   *
   * When EMPTY, the API grants NO browser origin in production (it used to
   * reflect any origin, letting any site call the API from a victim's
   * browser); outside production it still reflects any origin for
   * convenience. Native apps send no Origin header, so this never affects
   * the rider/driver apps. See lib/security.ts#resolveCorsOrigin.
   */
  corsAllowedOrigins: firstNonBlank(
    process.env.CORS_ALLOWED_ORIGINS,
    process.env.DEMO_OTP_CORS_ORIGINS,
  ),
  /**
   * Raw TRUST_PROXY value; interpreted by lib/security.ts#resolveTrustProxy.
   * Unset means 1 hop in production (Render's TLS proxy) and no trust
   * elsewhere. Trusting the whole chain lets clients spoof X-Forwarded-For
   * and bypass every per-IP rate limit.
   */
  trustProxy: process.env.TRUST_PROXY,
  /**
   * Public origin this server is reachable at, used to build the SOS ride
   * tracking link (GET /track/:token) that goes out by SMS. Must be the
   * externally-visible URL, not the bind address — an emergency contact
   * opens it on their own phone. Falls back to localhost for dev.
   */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  /**
   * Phase 4 safety backstop. Every SOS is also texted to this number, so a
   * rider who never saved an emergency contact still reaches a human. Unset
   * means support is simply not notified — the SOS still succeeds and still
   * texts the rider's own contact — so an unconfigured deployment degrades
   * rather than breaking the button.
   *
   * Full SOS visibility belongs in the Phase 5 admin panel; this is the
   * stopgap until then.
   */
  supportContactPhone: process.env.SUPPORT_CONTACT_PHONE ?? "",
  /**
   * How long an SOS tracking link (GET /track/:token) keeps working after
   * the ride ends, in hours (1–168, default 24). While the ride is going on
   * it always works. 24 h covers a contact who sees the text late or the
   * next morning, matching how long a rider can still call their driver
   * after a trip (services/user/driverInfo.ts); the text itself already
   * carries the driver's name and plate for anyone who needs them later.
   */
  trackingLinkTtlHours: Math.min(168, Math.max(1, Number(process.env.TRACKING_LINK_TTL_HOURS ?? 24) || 24)),
  /**
   * Cloudinary credentials for SIGNED driver-photo uploads. The apiSecret is
   * server-only and must never be exposed to the apps — it is what replaces
   * the old unsigned upload preset that shipped inside the app bundle.
   * cloudName is public (it appears in every image URL).
   *
   * Read from CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
   * (or CLOUDINARY_URL), trimmed — see services/uploads/cloudinaryConfig.ts.
   * `apiSecret` is the upload signing key: never log it.
   */
  cloudinary: resolveCloudinaryConfig(process.env),
  /**
   * Phase 5c dev-only mock driver: when true, every ride created via
   * POST /rides is driven through MATCHED -> ARRIVED -> IN_PROGRESS ->
   * COMPLETED by a simulated driver (src/dev/mockDriver.ts), emitting the
   * same Socket.io events Phase 6's real driver app will emit. Never enable
   * in production.
   */
  enableMockDriver: process.env.ENABLE_MOCK_DRIVER === "true",
  /**
   * USSD channel kill-switch. Default OFF: while false, `POST /ussd/callback`
   * is not reachable (404), which also closes off the unauthenticated rider
   * auto-provisioning (`findOrCreateRiderByPhone`) that callback triggers —
   * any phone number could otherwise mint a rider account with no
   * verification. The USSD service code is left intact and dormant; flip this
   * to "true" only once the callback has a gateway IP allowlist / shared
   * secret. Same pattern as `moolre.paymentsEnabled`.
   */
  enableUssd: process.env.ENABLE_USSD === "true",
  /**
   * The forced "Time to update" screen: per app and platform, the lowest
   * store version still allowed and the store link, served by
   * GET /app/min-version (MIN_VERSION_RIDER_IOS … STORE_URL_DRIVER_ANDROID,
   * lib/appMinVersions.ts). All unset = nobody is ever blocked.
   */
  appMinVersions: resolveAppMinVersions(process.env).versions,
  /**
   * How long a ride offer stays up on a driver's screen before it times out
   * (seconds). The app reads it from each offer, so changing it needs no app
   * release. Clamped to 5–60.
   */
  driverOfferSeconds: Math.min(60, Math.max(5, Number(process.env.DRIVER_OFFER_SECONDS ?? 15) || 15)),
  /**
   * Road routes between exact pins (services/routing/pointRoutes.ts). OSRM's
   * public demo server by default; point OSRM_BASE_URL at a self-hosted OSRM
   * when we outgrow it (docs/routing.md). ROUTING_DISABLED=true serves only
   * the stored zone routes. Never contacted under NODE_ENV=test.
   */
  /**
   * Push notifications through the Expo push service (services/push). On by
   * default; PUSH_DISABLED=true switches every send off (the rest of the app
   * is unaffected). Never contacted under NODE_ENV=test.
   *
   * EXPO_ACCESS_TOKEN is only needed if "Enhanced Security for Push
   * Notifications" is turned on for the Expo account. It is a secret: never
   * log it.
   */
  push: {
    enabled: process.env.PUSH_DISABLED !== "true" && process.env.NODE_ENV !== "test",
    accessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  },
  routing: {
    osrmBaseUrl: process.env.OSRM_BASE_URL ?? "https://router.project-osrm.org",
    disabled: process.env.ROUTING_DISABLED === "true" || process.env.NODE_ENV === "test",
    /** Give up on OSRM after this long and draw the fallback instead. */
    timeoutMs: Number(process.env.ROUTING_TIMEOUT_MS ?? 2_500),
    /** Fewest ms between two calls from this server: OSRM's demo asks for at most 1 a second. */
    minIntervalMs: Number(process.env.ROUTING_MIN_INTERVAL_MS ?? 1_100),
    /** Above this many OSRM calls in a UTC day, each further call logs a warning (time to self-host). */
    dailyWarnAt: Number(process.env.ROUTING_DAILY_WARN_AT ?? 3_000),
  },
} as const;
