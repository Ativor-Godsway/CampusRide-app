import { rateLimitText } from "./errorMessage";

/**
 * Turns a refused deletion step into a message worth showing. The server
 * explains itself in plain words for a wrong or expired code (400) and for a
 * ride still going on (409); anything else is reported generically rather
 * than leaking a raw error string onto the screen.
 */
export function describeDeleteAccountError(error: unknown): string {
  const response = (error as { response?: { status?: number; data?: { error?: string } } })?.response;
  const serverMessage = response?.data?.error;
  if ((response?.status === 400 || response?.status === 409) && serverMessage) return serverMessage;
  return rateLimitText(error) ?? "We couldn't reach CampusRide. Check your connection and try again.";
}

/** True when the server refused because a ride is still going on. */
export function isRideBlockingDeletion(error: unknown): boolean {
  return (error as { response?: { status?: number } })?.response?.status === 409;
}
