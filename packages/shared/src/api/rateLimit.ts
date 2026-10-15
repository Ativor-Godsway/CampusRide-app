/**
 * Rate-limit answers, shared by the server (which sends them) and the apps
 * (which turn them into "Try again in 3 minutes").
 *
 * Every 429 from the API carries a `Retry-After` header and this body. The
 * `error` text is already friendly, so a screen that just shows the server's
 * message is right; screens with their own wording use rateLimitMessage.
 */

export const RATE_LIMITED_CODE = "RATE_LIMITED";

export interface RateLimitedBody {
  error: string;
  code: typeof RATE_LIMITED_CODE;
  /** Whole seconds until the request will be accepted again (at least 1). */
  retryAfterSeconds: number;
}

/**
 * How long the code screen makes someone wait before "Resend code". The
 * server refuses a second code to the same number inside this window, so the
 * button counts down instead of letting people tap into a refusal.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60;

/** "45 seconds", "1 minute", "3 minutes", "about 2 hours". Rounds up, never says 0. */
export function retryAfterText(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} ${s === 1 ? "second" : "seconds"}`;
  if (s < 90 * 60) {
    const minutes = Math.ceil(s / 60);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.round(s / 3600);
  return `about ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** The sentence a person sees: "Too many attempts. Try again in 3 minutes." */
export function rateLimitMessage(seconds: number): string {
  return `Too many attempts. Try again in ${retryAfterText(seconds)}.`;
}

/** The body for a 429 that says to wait `seconds`. */
export function rateLimitedBody(seconds: number): RateLimitedBody {
  const retryAfterSeconds = Math.max(1, Math.ceil(seconds));
  return { error: rateLimitMessage(retryAfterSeconds), code: RATE_LIMITED_CODE, retryAfterSeconds };
}

/**
 * For a failed request (axios-shaped error): the seconds to wait if the API
 * answered 429, read from the body or else the Retry-After header; null for
 * any other failure. An app that predates a limit still gets a number.
 */
export function retryAfterSecondsOf(err: unknown): number | null {
  const response = (
    err as {
      response?: { status?: number; data?: unknown; headers?: Record<string, unknown> };
    } | null
  )?.response;
  if (response?.status !== 429) return null;
  const fromBody = (response.data as { retryAfterSeconds?: unknown } | undefined)
    ?.retryAfterSeconds;
  if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0)
    return Math.ceil(fromBody);
  const fromHeader = Number(response.headers?.["retry-after"]);
  return Number.isFinite(fromHeader) && fromHeader > 0 ? Math.ceil(fromHeader) : 60;
}

/** "0:42", "9:59", "1:00:00" — for a countdown on screen. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}
