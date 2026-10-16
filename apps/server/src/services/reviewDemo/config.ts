import { config } from "../../config";
import { normalizePhone } from "../../lib/phone";

/**
 * The App Store / Google Play review demo (docs/store/review-notes.md): two
 * phone numbers that log in with a fixed code and no SMS, a demo rider whose
 * requests a simulated driver serves, and a demo driver who gets simulated
 * requests. Off unless REVIEW_DEMO_ENABLED=true AND every setting is valid;
 * REVIEW_DEMO_ENABLED=false (or unset) is the kill switch.
 */
export interface ReviewDemoConfig {
  enabled: boolean;
  riderPhone: string | null;
  driverPhone: string | null;
  otp: string | null;
  /** Why it is off despite REVIEW_DEMO_ENABLED=true: setting names only, never values. */
  problems: string[];
}

export function resolveReviewDemo(
  env: NodeJS.ProcessEnv,
  adminPhones: readonly string[] = [],
): ReviewDemoConfig {
  const switchedOn = env.REVIEW_DEMO_ENABLED?.trim() === "true";
  const riderPhone = normalizePhone(env.REVIEW_DEMO_RIDER_PHONE ?? "");
  const driverPhone = normalizePhone(env.REVIEW_DEMO_DRIVER_PHONE ?? "");
  const otp = env.REVIEW_DEMO_OTP?.trim() ?? "";
  const problems: string[] = [];
  if (switchedOn) {
    if (!riderPhone)
      problems.push("REVIEW_DEMO_RIDER_PHONE is missing or not a valid Ghana number");
    if (!driverPhone)
      problems.push("REVIEW_DEMO_DRIVER_PHONE is missing or not a valid Ghana number");
    if (riderPhone && riderPhone === driverPhone)
      problems.push("REVIEW_DEMO_RIDER_PHONE and REVIEW_DEMO_DRIVER_PHONE are the same number");
    if (!/^\d{6}$/.test(otp)) problems.push("REVIEW_DEMO_OTP must be exactly 6 digits");
    if ([riderPhone, driverPhone].some((phone) => phone && adminPhones.includes(phone))) {
      problems.push("A review demo number is on ADMIN_PHONE_ALLOWLIST");
    }
  }
  const enabled = switchedOn && problems.length === 0;
  return {
    enabled,
    riderPhone: enabled ? riderPhone : null,
    driverPhone: enabled ? driverPhone : null,
    otp: enabled ? otp : null,
    problems,
  };
}

let active: ReviewDemoConfig | null = null;

/** The demo settings this server runs with. */
export function reviewDemoConfig(): ReviewDemoConfig {
  active ??= resolveReviewDemo(process.env, config.adminPhoneAllowlist.phones);
  return active;
}

/** Tests only: run with these settings (null: back to the environment's). */
export function setReviewDemoConfigForTests(next: ReviewDemoConfig | null): void {
  active = next;
}
