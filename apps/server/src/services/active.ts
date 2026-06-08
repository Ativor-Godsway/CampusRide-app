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
 *   - "moolre"  -> MoolreOtpService, only if moolre.enabled AND vasKey AND smsSenderId are set.
 *   - "mnotify" -> MnotifyOtpService, only if mnotify.enabled.
 *   - anything else (incl. unset/"dummy") -> DummyOtpService.
 * Tests and local dev default to DummyOtpService, which logs the OTP to the
 * console instead of sending an SMS — no real SMS sent in the test suite.
 *
 * paymentService is real (Moolre) only when MOOLRE_ENABLED=true; tests and
 * local dev always get DummyPaymentService, which never hits the network.
 */
export const paymentService = config.moolre.enabled
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
  moolre: { enabled: boolean; baseUrl: string; apiUser: string; vasKey: string; smsSenderId: string };
  mnotify: { enabled: boolean; apiKey: string; senderId: string };
}

/**
 * Pure provider-selection logic, exported separately so it can be unit
 * tested with arbitrary config shapes without touching env vars or module
 * state. See the precedence rules in the module doc-comment above.
 */
export function resolveOtpService(cfg: OtpProviderConfig): OtpService {
  if (cfg.otpProvider === "moolre" && cfg.moolre.enabled && cfg.moolre.vasKey && cfg.moolre.smsSenderId) {
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
