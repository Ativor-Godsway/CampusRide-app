/** Extracts a user-facing message from an axios error, falling back to a generic message. */
export function errorMessage(err: unknown): string {
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
