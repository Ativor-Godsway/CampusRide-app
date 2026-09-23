import { config } from "../config";
import { DummyPaymentService } from "./payment/DummyPaymentService";
import { MoolrePaymentService } from "./payment/MoolrePaymentService";
import { DummyRouteService } from "./route/DummyRouteService";
import type { OtpService } from "./otp/OtpService";
import { DummyOtpService } from "./otp/DummyOtpService";
import { MnotifyOtpService } from "./otp/MnotifyOtpService";
import { MoolreOtpService } from "./otp/MoolreOtpService";

/**
 * Active service implementations, in one place so both index.ts and the
 * route modules can import them without index.ts <-> routes circular
 * imports.
 *
 * otpService provider is selected via OTP_PROVIDER (see config.ts), with a
 * fallback to DummyOtpService if the requested provider's prerequisites
 * aren't met:
 *   - "moolre"  -> MoolreOtpService, only if moolre.smsEnabled AND vasKey AND smsSenderId are set.
 *   - "mnotify" -> MnotifyOtpService, only if mnotify.enabled.
 *   - anything else (incl. unset/"dummy") -> DummyOtpService.
 * Tests and local dev default to DummyOtpService, which logs the OTP to the
 * console instead of sending an SMS — no real SMS sent in the test suite.
 *
 * paymentService is real (Moolre) only when MOOLRE_PAYMENTS_ENABLED=true;
 * tests and local dev always get DummyPaymentService, which never hits the
 * network. NOTE: payments and SMS are gated by SEPARATE flags — the launch
 * configuration is SMS on (real OTPs) with payments off (cash-only).
 */
export const paymentService = config.moolre.paymentsEnabled
  ? new MoolrePaymentService({
      baseUrl: config.moolre.baseUrl,
      apiUser: config.moolre.apiUser,
      publicKey: config.moolre.publicKey,
      privateKey: config.moolre.privateKey,
      accountNumber: config.moolre.accountNumber,
    })
  : new DummyPaymentService();
export const routeService = new DummyRouteService();

export interface OtpProviderConfig {
  otpProvider: string;
  moolre: { smsEnabled: boolean; baseUrl: string; apiUser: string; vasKey: string; smsSenderId: string };
  mnotify: { enabled: boolean; apiKey: string; senderId: string };
}

/**
 * Pure provider-selection logic, exported separately so it can be unit
 * tested with arbitrary config shapes without touching env vars or module
 * state. See the precedence rules in the module doc-comment above.
 */
export function resolveOtpService(cfg: OtpProviderConfig): OtpService {
  if (cfg.otpProvider === "moolre" && cfg.moolre.smsEnabled && cfg.moolre.vasKey && cfg.moolre.smsSenderId) {
    return new MoolreOtpService({
      baseUrl: cfg.moolre.baseUrl,
      apiUser: cfg.moolre.apiUser,
      vasKey: cfg.moolre.vasKey,
      senderId: cfg.moolre.smsSenderId,
    });
  }
  if (cfg.otpProvider === "mnotify" && cfg.mnotify.enabled) {
    return new MnotifyOtpService(cfg.mnotify.apiKey, cfg.mnotify.senderId);
  }
  return new DummyOtpService();
}

export const otpService = resolveOtpService(config);

/**
 * Thrown at boot when the selected OTP provider would silently no-op in
 * production. Exported so the startup path can distinguish it from an
 * ordinary crash.
 */
export class InsecureOtpProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsecureOtpProviderError";
  }
}

/**
 * Boot guard: DummyOtpService never sends a real SMS, so running it in
 * production means every user's login code goes nowhere (and previously, to
 * the logs). Before Phase 2 the production default was literally
 * OTP_PROVIDER=dummy, so this failed silently and invisibly. Fail loud
 * instead — a server that cannot deliver login codes is not serviceable and
 * should not accept traffic.
 *
 * Pure and injectable so it can be unit tested without touching env vars.
 */
export function assertOtpServiceAllowedInProduction(
  service: OtpService,
  nodeEnv: string,
): void {
  if (nodeEnv === "production" && service instanceof DummyOtpService) {
    throw new InsecureOtpProviderError(
      "Refusing to start: OTP_PROVIDER resolved to DummyOtpService while NODE_ENV=production, " +
        "so login codes would never reach users. Set OTP_PROVIDER=moolre with MOOLRE_SMS_ENABLED=true " +
        "plus MOOLRE_VAS_KEY and MOOLRE_SMS_SENDER_ID (or OTP_PROVIDER=mnotify with MNOTIFY_ENABLED=true).",
    );
  }
}
