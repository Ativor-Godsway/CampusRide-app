import { config } from "../config";
import { DummyPaymentService } from "./payment/DummyPaymentService";
import { DummyRouteService } from "./route/DummyRouteService";
import { DummyOtpService } from "./otp/DummyOtpService";
import { MnotifyOtpService } from "./otp/MnotifyOtpService";

/**
 * Active service implementations, in one place so both index.ts and the
 * route modules can import them without index.ts <-> routes circular
 * imports.
 *
 * otpService is real (mNotify) only when MNOTIFY_ENABLED=true; tests and
 * local dev always get DummyOtpService, which logs the OTP to the console
 * instead of sending an SMS.
 */
export const paymentService = new DummyPaymentService();
export const routeService = new DummyRouteService();
export const otpService = config.mnotify.enabled
  ? new MnotifyOtpService(config.mnotify.apiKey, config.mnotify.senderId)
  : new DummyOtpService();
