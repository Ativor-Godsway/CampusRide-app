import dotenv from "dotenv";
import path from "node:path";

// Per-environment .env loading (dev/test/prod split — see docs/environments.md).
// NODE_ENV picks the file: `.env.development` (default), `.env.test` (vitest
// sets NODE_ENV=test), or none in production (Render injects real env vars, and
// no .env* file is deployed). We load the env-specific file FIRST, then `.env`
// as a fallback — dotenv never overrides an already-set var, so the specific
// file and any real process env (Render) both win over the base `.env`. This is
// what keeps local dev/tests OFF the production database.
const NODE_ENV = process.env.NODE_ENV ?? "development";
const serverRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(serverRoot, `.env.${NODE_ENV}`) });
dotenv.config({ path: path.join(serverRoot, ".env") });

export const APP_NAME = "CampusRide";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: process.env.JWT_SECRET ?? "",
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
  },
  /**
   * Rate-limit ceilings (max requests per IP per window). Env-overridable so
   * they can be tuned on Render without a redeploy — the windows are fixed in
   * code (see index.ts / route configs), only the max counts are configurable.
   * All default to the values agreed in the Phase-1 plan.
   */
  rateLimit: {
    /** Global fallback: any route without its own override. Per minute. */
    globalMax: Number(process.env.RATE_LIMIT_GLOBAL_MAX ?? 100),
    /** POST /auth/request-otp — per 15 min. Layered ON TOP of per-phone caps. */
    otpRequestMax: Number(process.env.RATE_LIMIT_OTP_REQUEST ?? 5),
    /** POST /auth/verify-otp — per 15 min. On top of the 5-attempts-per-OTP cap. */
    otpVerifyMax: Number(process.env.RATE_LIMIT_OTP_VERIFY ?? 10),
    /** POST /auth/login — per 15 min. */
    loginMax: Number(process.env.RATE_LIMIT_LOGIN ?? 10),
    /** POST /auth/signup — per 15 min. */
    signupMax: Number(process.env.RATE_LIMIT_SIGNUP ?? 10),
    /** POST /auth/refresh — per 15 min (higher: legitimate silent re-auth). */
    refreshMax: Number(process.env.RATE_LIMIT_REFRESH ?? 30),
    /** POST /rides (create) — per 15 min. */
    rideCreateMax: Number(process.env.RATE_LIMIT_RIDE_CREATE ?? 20),
    /** POST /rides/:id/initiate-payment — per 15 min (each hits Moolre). */
    paymentInitMax: Number(process.env.RATE_LIMIT_PAYMENT_INIT ?? 15),
    /** POST /ussd/callback — per minute (a USSD session fires many keypresses). */
    ussdCallbackMax: Number(process.env.RATE_LIMIT_USSD_CALLBACK ?? 60),
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
} as const;
