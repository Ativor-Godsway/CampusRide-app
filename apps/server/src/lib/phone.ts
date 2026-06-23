/**
 * Phone number normalization — the canonical stored/looked-up form is
 * "+233XXXXXXXXX" (a "+" followed by Ghana's country code and a 9-digit
 * subscriber number). The app's PhoneScreen invites users to type
 * "+233 ...", but nothing has ever enforced that server-side; Moolre's USSD
 * callback sends "233XXXXXXXXX" (no "+"). Without normalization a USSD
 * rider's msisdn will never match an app-created User.phone.
 */

/**
 * Normalizes a Ghanaian phone number to "+233XXXXXXXXX". Accepts:
 *   - "+233XXXXXXXXX" (already canonical)
 *   - "233XXXXXXXXX"  (Moolre's USSD msisdn format)
 *   - "0XXXXXXXXX"    (local format, 10 digits)
 * Strips spaces and dashes before matching. Returns null if the input
 * doesn't resolve to a 9-digit Ghanaian subscriber number.
 */
export function normalizePhone(input: string): string | null {
  const cleaned = input.replace(/[\s-]/g, "");

  if (/^\+233\d{9}$/.test(cleaned)) {
    return cleaned;
  }
  if (/^233\d{9}$/.test(cleaned)) {
    return `+${cleaned}`;
  }
  if (/^0\d{9}$/.test(cleaned)) {
    return `+233${cleaned.slice(1)}`;
  }

  return null;
}

/** True if `input` normalizes to a valid Ghanaian phone number. */
export function isValidGhanaPhone(input: string): boolean {
  return normalizePhone(input) !== null;
}
