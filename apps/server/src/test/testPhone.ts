/**
 * Unique, valid, UNMISTAKABLY SYNTHETIC phone numbers for test fixtures.
 *
 * Two constraints pull against each other:
 *
 *  1. The number must be structurally valid. The auth routes normalize at the
 *     edge and 400 anything that is not a Ghanaian number, and the
 *     User_phone_canonical_check constraint rejects it at the database. The
 *     old fixtures ("+233-auth-test-1790194783385-7") satisfy neither.
 *
 *  2. The number must be identifiable as a fixture. ~353 fixture accounts once
 *     reached the production database, and the ONLY reason they could be found
 *     and cleaned up safely is that their phone numbers were obviously fake.
 *     A fixture that looks like a real subscriber is unrecoverable: there is no
 *     way to tell it from a customer without guessing, and guessing wrong
 *     deletes a real person's ride history.
 *
 * So fixtures use the reserved prefix "+2330". It passes normalizePhone
 * (+233 followed by nine digits) while being impossible as a real Ghanaian
 * mobile number — every real subscriber number begins 2, 5 or similar after
 * the country code, never 0. One SQL LIKE finds every fixture row and can
 * never match a customer.
 *
 *   +233 | 0        | SS       | MMM       | NNN
 *        | reserved | per-proc | ms of sec | counter
 */

/** Any phone matching this is a test fixture and can never be a real subscriber. */
export const TEST_PHONE_PREFIX = "+2330";

let counter = 0;
const processSeed = Math.floor(Math.random() * 90) + 10; // 10–99

/** Returns a fresh, unique, structurally valid fixture number. */
export function uniqueGhanaPhone(): string {
  counter += 1;
  const ms = String(Date.now() % 1000).padStart(3, "0");
  const serial = String(counter % 1000).padStart(3, "0");
  return `${TEST_PHONE_PREFIX}${processSeed}${ms}${serial}`;
}

/**
 * The same number in the bare msisdn form Moolre's USSD callback sends
 * ("2330XXXXXXXX"), for tests that drive the USSD handler.
 */
export function uniqueGhanaMsisdn(): string {
  return uniqueGhanaPhone().slice(1);
}
