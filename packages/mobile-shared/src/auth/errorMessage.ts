import { rateLimitMessage, retryAfterSecondsOf } from "@rida/shared";

/**
 * "Too many attempts. Try again in 3 minutes." when the API rate-limited
 * the request, otherwise null. For screens with their own wording for
 * failures: check this first, so a 429 is never shown as "check your
 * connection".
 */
export function rateLimitText(err: unknown): string | null {
  const seconds = retryAfterSecondsOf(err);
  return seconds === null ? null : rateLimitMessage(seconds);
}

/** Extracts a user-facing message from an axios error, falling back to a generic message. */
export function errorMessage(err: unknown): string {
  const limited = rateLimitText(err);
  if (limited) return limited;
  if (err && typeof err === "object" && "response" in err) {
    const response = (err as { response?: { data?: { error?: string } } }).response;
    if (response?.data?.error) return response.data.error;
  }
  return "Something went wrong. Try again.";
}

/** The HTTP status of a failed request, or undefined when nothing came back (timeout, offline). */
export function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** The server's own reason (`{ error }`) for a refused request, if it gave one. */
export function serverReason(err: unknown): string | null {
  const data = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  return typeof data?.error === "string" ? data.error : null;
}

/**
 * A texted code the server refused (400: wrong, expired, too many tries),
 * in plain words, or null for any other failure (offline, rate limit), which
 * must not clear what was typed. The server's own messages are for its logs.
 */
export function wrongCodeMessage(err: unknown): string | null {
  if (errorStatus(err) !== 400 || rateLimitText(err)) return null;
  const reason = serverReason(err) ?? "";
  if (/expired/i.test(reason)) return "That code has expired. Ask for a new one below.";
  if (/too many/i.test(reason)) return "Too many tries with that code. Ask for a new one below.";
  return "That code didn't match. Check the SMS and try again.";
}
