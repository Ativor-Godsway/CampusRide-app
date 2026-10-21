import { classifyActionFailure, refusalMessage } from "./actionFailure";

/**
 * Why a request the driver tried to accept went away (POST /rides/:id/claim
 * answers 409 RIDE_NOT_AVAILABLE with one of these).
 */
export type RequestGoneReason = "TAKEN" | "CANCELLED" | "EXPIRED";

/** What Accept on an offer (or a Home request card) ends in. */
export type ClaimOutcome =
  /** The trip is the driver's: go to it. */
  | { kind: "accepted" }
  /** Taken, cancelled or expired: close the offer and say so in a toast. */
  | { kind: "gone"; reason: RequestGoneReason }
  /** The server said no for another reason (offline, already on a trip): say why, offer Try again. */
  | { kind: "refused"; message: string }
  /** No answer (timeout, offline, a 5xx): offer Try again. Claiming twice is safe. */
  | { kind: "network" };

/** The toast after a request went away. */
export const REQUEST_GONE_TOAST: Record<RequestGoneReason, string> = {
  TAKEN: "That request was taken",
  CANCELLED: "The rider cancelled that request",
  EXPIRED: "That request expired",
};

/** In the offer panel when Accept got no answer. */
export const CLAIM_NETWORK_MESSAGE =
  "Couldn't reach CampusRide. Check your connection and try again.";

/**
 * A failed claim, from the error's HTTP status and body (`{ code, reason, error }`).
 * A 409 RIDE_NOT_AVAILABLE is "gone" (EXPIRED when the reason is missing or
 * unknown); any other real answer is a refusal in the server's words; no
 * answer, a 5xx, 408 or 429 is a network problem.
 */
export function classifyClaimFailure(failure: {
  status?: number | null;
  code?: unknown;
  reason?: unknown;
  error?: unknown;
}): Exclude<ClaimOutcome, { kind: "accepted" }> {
  if (classifyActionFailure(failure.status) === "retry") return { kind: "network" };
  if (failure.status === 409 && failure.code === "RIDE_NOT_AVAILABLE") {
    const reason =
      failure.reason === "TAKEN" || failure.reason === "CANCELLED" ? failure.reason : "EXPIRED";
    return { kind: "gone", reason };
  }
  return {
    kind: "refused",
    message: refusalMessage(
      typeof failure.error === "string" ? failure.error : null,
      "Couldn't accept this request.",
    ),
  };
}
