import { normalizeGhanaPhone } from "@rida/shared";

/**
 * Phone number normalization — the canonical stored/looked-up form is
 * "+233XXXXXXXXX" (a "+" followed by Ghana's country code and a 9-digit
 * subscriber number). The app's PhoneScreen invites users to type
 * "+233 ...", but nothing has ever enforced that server-side; Moolre's USSD
 * callback sends "233XXXXXXXXX" (no "+"). Without normalization a USSD
 * rider's msisdn will never match an app-created User.phone.
 */

/**
 * Normalizes a Ghanaian phone number to "+233XXXXXXXXX", or null.
 *
 * This IS the shared parser in @rida/shared (normalizeGhanaPhone), which the
 * login screens of every app use too, so the server and the apps can never
 * disagree about a number: local (0…), international (+233…), 233… and
 * 00233…, with any spaces, dashes, brackets or dots, and with the invisible
 * characters phones and browsers add to copied or autofilled numbers.
 */
export function normalizePhone(input: string): string | null {
  return normalizeGhanaPhone(input);
}

/** True if `input` normalizes to a valid Ghanaian phone number. */
export function isValidGhanaPhone(input: string): boolean {
  return normalizePhone(input) !== null;
}

/**
 * The form Moolre's SMS/VAS API wants: "233XXXXXXXXX", no leading "+".
 * Returns null for anything that isn't a Ghanaian number, so callers can
 * decide whether to fall back or refuse.
 */
export function toMsisdn(input: string): string | null {
  const canonical = normalizePhone(input);
  return canonical ? canonical.slice(1) : null;
}

/**
 * Every stored form a given number might plausibly appear as in User.phone.
 *
 * The column is canonical since migration 20260924210000, so in practice only
 * the canonical variant matches a row today. The other forms are kept because
 * the INPUT is still arbitrary — an operator typing a local number, a USSD
 * msisdn, a pasted string — and because a lookup that tolerates all of them
 * cannot regress the way the original bug did.
 *
 * Returns the canonical form first, then the other equivalents, then the raw
 * input, de-duplicated and preserving that order. For a non-Ghanaian or
 * unparseable input it degrades to just the trimmed raw value.
 *
 * Use this for LOOKUPS, never for writes: writes go through normalizePhone so
 * the column stays single-format. See docs/phone-formats.md.
 */
export function phoneVariants(input: string): string[] {
  const raw = input.trim();
  const canonical = normalizePhone(raw);

  if (!canonical) return raw ? [raw] : [];

  const local = `0${canonical.slice("+233".length)}`;
  const withoutPlus = canonical.slice(1);

  return [...new Set([canonical, local, withoutPlus, raw])].filter(Boolean);
}
