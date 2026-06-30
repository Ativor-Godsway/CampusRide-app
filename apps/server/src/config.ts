import "dotenv/config";

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
    enabled: process.env.MOOLRE_ENABLED === "true",
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
   * Selects the OTP delivery provider. One of "moolre" | "mnotify" | "dummy".
   * Precedence (see services/active.ts):
   *   - "moolre"  -> MoolreOtpService, only if moolre.enabled AND vasKey/smsSenderId set.
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
} as const;
