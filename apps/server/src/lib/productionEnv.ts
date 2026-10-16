import { normalizePhone } from "./phone";
import { parsePhoneList } from "../config";

/**
 * What a production server must be given before it may start. index.ts runs
 * checkProductionEnv at boot and refuses to listen if anything is an error,
 * naming the variables — never their values. Render then keeps the previous
 * version running (the new deploy never passes its health check).
 *
 * REQUIRED (errors):
 *   DATABASE_URL, DIRECT_URL        the Neon database (pooled, direct)
 *   JWT_SECRET                      at least 32 random bytes, not a placeholder
 *   PUBLIC_BASE_URL                 https:// — SOS links are texted with it
 *   CORS_ALLOWED_ORIGINS            the admin site's https origin(s)
 *   ADMIN_PHONE_ALLOWLIST           at least one admin number, no typos
 *   SUPPORT_CONTACT_PHONE           every SOS also reaches this number
 *   login codes: OTP_PROVIDER=moolre + MOOLRE_SMS_ENABLED=true + MOOLRE_VAS_KEY
 *                + MOOLRE_SMS_SENDER_ID  (or OTP_PROVIDER=mnotify + MNOTIFY_ENABLED=true + MNOTIFY_API_KEY)
 *   with MOOLRE_PAYMENTS_ENABLED=true: MOOLRE_API_USER, MOOLRE_PUBLIC_KEY,
 *                MOOLRE_PRIVATE_KEY, MOOLRE_ACCOUNT_NUMBER, MOOLRE_WEBHOOK_SECRET
 * FORBIDDEN (errors): ENABLE_MOCK_DRIVER=true, ENABLE_USSD=true (the callback
 *   has no authentication yet), TRUST_PROXY=true (spoofable client IPs).
 * WARNINGS: Cloudinary unset (driver photos answer 503), TRUST_PROXY set at
 *   all, payments on against Moolre's sandbox.
 */
export interface EnvCheck {
  errors: string[];
  warnings: string[];
}

type Env = Record<string, string | undefined>;

const PLACEHOLDER = /replace[-_ ]?with|change[-_ ]?me|your[-_]|example|placeholder/i;

/** Roughly how many random bytes a secret string carries (hex, base64, or raw text). */
export function secretBytes(secret: string): number {
  const s = secret.trim();
  if (/^[0-9a-f]+$/i.test(s)) return Math.floor(s.length / 2);
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return Math.floor((s.replace(/=+$/, "").length * 3) / 4);
  return Buffer.byteLength(s, "utf8");
}

/** Why a JWT secret isn't good enough, or null when it is. */
export function jwtSecretProblem(secret: string | undefined): string | null {
  if (!secret || secret.trim() === "") return "JWT_SECRET is not set";
  if (PLACEHOLDER.test(secret)) return "JWT_SECRET is a placeholder, not a secret";
  if (new Set(secret).size < 16) return "JWT_SECRET is too repetitive to be random";
  const bytes = secretBytes(secret);
  if (bytes < 32) {
    return `JWT_SECRET is too short (about ${bytes} bytes; needs at least 32 random bytes — generate one with: openssl rand -hex 32)`;
  }
  return null;
}

function isTrue(value: string | undefined): boolean {
  return value === "true";
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function httpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function checkProductionEnv(env: Env): EnvCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const requireSet = (name: string, why: string) => {
    if (blank(env[name])) errors.push(`${name} is not set (${why})`);
  };

  // Database.
  requireSet("DATABASE_URL", "the Neon pooled connection string");
  requireSet("DIRECT_URL", "the Neon direct connection string");
  if (!blank(env.DATABASE_URL) && !/^postgres(ql)?:\/\//.test(env.DATABASE_URL!)) {
    errors.push("DATABASE_URL is not a postgres:// connection string");
  }
  if (!blank(env.DATABASE_URL) && /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL!)) {
    errors.push("DATABASE_URL points at localhost");
  }

  // Tokens.
  const jwt = jwtSecretProblem(env.JWT_SECRET);
  if (jwt) errors.push(jwt);

  // Public URLs and browsers.
  if (blank(env.PUBLIC_BASE_URL))
    errors.push("PUBLIC_BASE_URL is not set (SOS tracking links are built from it)");
  else if (!httpsUrl(env.PUBLIC_BASE_URL!))
    errors.push("PUBLIC_BASE_URL must be an https:// address that isn't localhost");

  const cors = blank(env.CORS_ALLOWED_ORIGINS)
    ? env.DEMO_OTP_CORS_ORIGINS
    : env.CORS_ALLOWED_ORIGINS;
  const origins = (cors ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0)
    errors.push("CORS_ALLOWED_ORIGINS is not set (the admin site can't reach the API without it)");
  else if (origins.some((o) => !httpsUrl(o)))
    errors.push("CORS_ALLOWED_ORIGINS must list only https:// origins");

  // Admins and safety.
  const admins = parsePhoneList(env.ADMIN_PHONE_ALLOWLIST);
  if (admins.phones.length === 0)
    errors.push("ADMIN_PHONE_ALLOWLIST is not set (nobody could use the admin site)");
  if (admins.invalid.length > 0) {
    errors.push(
      `ADMIN_PHONE_ALLOWLIST has ${admins.invalid.length} entr${admins.invalid.length === 1 ? "y" : "ies"} that aren't Ghanaian numbers`,
    );
  }
  if (blank(env.SUPPORT_CONTACT_PHONE)) {
    errors.push(
      "SUPPORT_CONTACT_PHONE is not set (an SOS from a rider with no emergency contact would reach nobody)",
    );
  } else if (!normalizePhone(env.SUPPORT_CONTACT_PHONE!)) {
    errors.push("SUPPORT_CONTACT_PHONE is not a Ghanaian number");
  }

  // Login codes must really be sent.
  const provider = env.OTP_PROVIDER ?? "dummy";
  if (provider === "moolre") {
    if (!isTrue(env.MOOLRE_SMS_ENABLED ?? env.MOOLRE_ENABLED))
      errors.push("MOOLRE_SMS_ENABLED must be true with OTP_PROVIDER=moolre");
    requireSet("MOOLRE_VAS_KEY", "Moolre SMS key, for login codes");
    requireSet("MOOLRE_SMS_SENDER_ID", "approved SMS sender id, for login codes");
  } else if (provider === "mnotify") {
    if (!isTrue(env.MNOTIFY_ENABLED))
      errors.push("MNOTIFY_ENABLED must be true with OTP_PROVIDER=mnotify");
    requireSet("MNOTIFY_API_KEY", "mNotify key, for login codes");
  } else {
    errors.push("OTP_PROVIDER must be moolre or mnotify (login codes would never be sent)");
  }

  // Payments, when switched on.
  if (isTrue(env.MOOLRE_PAYMENTS_ENABLED ?? env.MOOLRE_ENABLED)) {
    for (const name of [
      "MOOLRE_API_USER",
      "MOOLRE_PUBLIC_KEY",
      "MOOLRE_PRIVATE_KEY",
      "MOOLRE_ACCOUNT_NUMBER",
    ]) {
      requireSet(name, "needed while MOOLRE_PAYMENTS_ENABLED=true");
    }
    if ((env.MOOLRE_WEBHOOK_SECRET ?? "").length < 16) {
      errors.push(
        "MOOLRE_WEBHOOK_SECRET must be set, at least 16 characters, while payments are on",
      );
    }
    if ((env.MOOLRE_BASE_URL ?? "https://sandbox.moolre.com").includes("sandbox")) {
      warnings.push("Payments are on but MOOLRE_BASE_URL is Moolre's sandbox");
    }
  }

  // Switches that must stay off in production.
  if (isTrue(env.ENABLE_MOCK_DRIVER))
    errors.push("ENABLE_MOCK_DRIVER=true is for development only");
  if (isTrue(env.ENABLE_USSD)) {
    errors.push(
      "ENABLE_USSD=true: the USSD callback has no authentication yet (needs a Moolre gateway IP allowlist or secret first)",
    );
  }
  if (env.TRUST_PROXY?.trim() === "true")
    errors.push("TRUST_PROXY=true lets any client choose its own IP");
  else if (!blank(env.TRUST_PROXY))
    warnings.push("TRUST_PROXY is set; leave it unset on Render (docs/security/rate-limits.md)");

  // Features that degrade without their settings.
  const cloudinary =
    !blank(env.CLOUDINARY_URL) ||
    (!blank(env.CLOUDINARY_CLOUD_NAME) &&
      !blank(env.CLOUDINARY_API_KEY) &&
      !blank(env.CLOUDINARY_API_SECRET));
  if (!cloudinary)
    warnings.push("Cloudinary is not configured: driver photo uploads will answer 503");
  if (blank(env.SENTRY_DSN))
    warnings.push(
      "SENTRY_DSN is not set: errors and alerts are only logged, not sent to Sentry (DEPLOY.md, Monitoring)",
    );

  return { errors, warnings };
}

/**
 * On Render, NODE_ENV must be production: every production safeguard above
 * (and the real rate limits, real login codes, closed CORS) keys off it.
 * Render sets RENDER=true on its services.
 */
export function checkDeployEnv(env: Env): string | null {
  if (
    env.RENDER === "true" &&
    env.NODE_ENV !== "production" &&
    env.ALLOW_NON_PRODUCTION_ON_RENDER !== "true"
  ) {
    return "NODE_ENV must be production on Render (it is what switches on every production safeguard)";
  }
  return null;
}
