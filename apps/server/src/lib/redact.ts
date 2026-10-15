/**
 * What may never appear in a log line (Stage 4): full phone numbers, login
 * codes, access/refresh/verification tokens, push tokens, tracking-link
 * tokens, secrets. Every log line — Fastify's request logger (index.ts) and
 * the background logger (lib/logger.ts) — passes through redactValue, so a
 * careless `log.info({ phone })` is masked rather than leaked.
 *
 *   +233548617146        -> +233*****146   (enough to recognise, not to dial)
 *   0548617146, 233…     -> +233*****146
 *   eyJhbGciOi….….…      -> [jwt]
 *   ExponentPushToken[…] -> ExponentPushToken[…]
 *   /track/9f2c…         -> /track/[token]
 *   32+ hex characters   -> [hex]          (refresh tokens, tracking tokens)
 *   postgresql://u:pw@h  -> postgresql://[credentials]@h
 *   { token: "…" }       -> { token: "[redacted]" } for every secret-named field
 */

/** "+233548617146" -> "+233*****146". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "*".repeat(Math.max(1, phone.length));
  return `+233*****${digits.slice(-3)}`;
}

/** A Ghana number in any of its usual compact forms, not inside a longer run of digits. */
const PHONE = /(?<!\d)(?:\+?233|0)\d{9}(?!\d)/g;
const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
const EXPO_PUSH_TOKEN = /Expo(?:nent)?PushToken\[[^\]]*\]/g;
const TRACK_PATH = /\/track\/[^/?#\s"]+/g;
const LONG_HEX = /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi;
/** user:password@ inside a URL (a database error can quote its connection string). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** A string with every phone number, token and secret-looking value masked. */
export function redactText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, "$1[credentials]@")
    .replace(TRACK_PATH, "/track/[token]")
    .replace(JWT, "[jwt]")
    .replace(EXPO_PUSH_TOKEN, "ExponentPushToken[…]")
    .replace(LONG_HEX, "[hex]")
    .replace(PHONE, (match) => maskPhone(match));
}

/** Field names whose value is always a secret, whatever it looks like. */
const SECRET_KEYS = new Set(
  [
    "authorization",
    "cookie",
    "token",
    "accesstoken",
    "refreshtoken",
    "verifiedtoken",
    "verificationtoken",
    "pushtoken",
    "trackingtoken",
    "secret",
    "password",
    "apikey",
    "privatekey",
    "publickey",
    "vaskey",
    "otp",
    "otpcode",
    "jwt",
  ].map((k) => k.toLowerCase()),
);

/** Left to their own serializers (Fastify's req/res, errors), never walked into. */
const PASSTHROUGH_KEYS = new Set(["req", "res", "err", "error", "request", "reply"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A log argument with everything sensitive masked: strings are scrubbed,
 * secret-named fields replaced, plain objects and arrays walked (to a fixed
 * depth). Errors and framework objects are left for their serializers.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth > 5) return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase()))
      out[key] = v === undefined || v === null ? v : "[redacted]";
    else if (PASSTHROUGH_KEYS.has(key)) out[key] = v;
    else out[key] = redactValue(v, depth + 1);
  }
  return out;
}

/** An error as a log line may show it: its type and code, message and stack scrubbed. */
export function redactError(err: unknown): unknown {
  if (!(err instanceof Error)) return redactValue(err);
  const withCode = err as Error & { code?: unknown; statusCode?: unknown };
  return {
    type: err.name,
    message: redactText(err.message),
    stack: err.stack ? redactText(err.stack) : undefined,
    ...(withCode.code !== undefined ? { code: withCode.code } : {}),
    ...(withCode.statusCode !== undefined ? { statusCode: withCode.statusCode } : {}),
  };
}
