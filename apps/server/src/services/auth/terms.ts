import { TERMS_VERSION } from "@rida/shared";

/**
 * What "I'm 18 or older and I agree to the Terms and Privacy Policy" writes on
 * an account: when, and which version of the terms (TERMS_VERSION, the
 * pages' "Last updated" date). Written at sign-up, by POST /me/terms for an
 * account from before sign-up asked, and on the review demo accounts.
 */
export function termsConfirmation(now: Date = new Date()) {
  return { ageConfirmedAt: now, termsAcceptedAt: now, termsVersion: TERMS_VERSION };
}
