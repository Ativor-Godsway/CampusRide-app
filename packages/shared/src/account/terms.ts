/**
 * The confirmation every account gives once, at sign-up (or, for accounts
 * from before it existed, the next time the app opens): "I'm 18 or older and
 * I agree to the Terms and Privacy Policy".
 *
 * TERMS_VERSION is the "Last updated" date of campusride.app/terms and
 * /privacy (apps/web reads it from this file), as YYYY-MM-DD. The server
 * records it with the confirmation, so it's known which wording someone
 * agreed to. Change it whenever either page changes.
 */
export const TERMS_VERSION = "2026-10-21";

export const MINIMUM_AGE = 18;

export const TERMS_URL = "https://campusride.app/terms";
export const PRIVACY_URL = "https://campusride.app/privacy";

/** Who still has to confirm: an account with no recorded confirmation. */
export interface TermsConfirmationState {
  /** ISO time, null until confirmed. Absent from an older server: then nobody is asked. */
  termsAcceptedAt?: string | Date | null;
  ageConfirmedAt?: string | Date | null;
}

/**
 * Whether this signed-in account must confirm before using the app. Only a
 * definite "never confirmed" (null) counts: a server too old to say (the
 * field absent) never locks anyone out.
 */
export function needsTermsConfirmation(user: TermsConfirmationState): boolean {
  return user.termsAcceptedAt === null || user.ageConfirmedAt === null;
}
