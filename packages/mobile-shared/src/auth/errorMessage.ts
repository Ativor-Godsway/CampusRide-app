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
