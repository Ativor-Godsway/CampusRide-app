/**
 * Ghana phone numbers — the ONE parser every part of CampusRide uses: the
 * server (every route that takes a number, the admin allowlist, SMS), and
 * the rider, driver and admin login screens. The canonical form, stored in
 * User.phone and used everywhere, is "+233" followed by the 9-digit
 * subscriber number: "+233548617924".
 *
 * Accepted, all meaning +233548617924:
 *
 *   0548617924        local
 *   +233548617924     international
 *   233548617924      without the + (Moolre's format)
 *   00233548617924    international with 00
 *   +233 (0) 54…      international with the local 0 kept by mistake
 *
 * with any spaces, dashes, dots, slashes or brackets between the digits, and
 * — the cause of the 2026-10 admin login bug — any INVISIBLE characters
 * around them. Phones and browsers wrap copied or autofilled numbers in
 * direction marks (U+202A … U+202C, U+200E) and non-breaking spaces; a
 * person can't see them, so "0548617924" looked right and was refused.
 * Full-width digits from some keyboards are read as ordinary digits.
 *
 * Letters, other country codes and wrong digit counts are refused.
 */

/** Characters with no visible width that phones and browsers slip into copied or autofilled text. */
const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;

/** Everything people put between the digits of a phone number. */
const SEPARATORS = /[\s\-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D().[\]/]/g;

/** Full-width forms ("\uFF10\uFF15\uFF14", "\uFF0B") as their ordinary characters, where the engine can. */
function ordinaryCharacters(input: string): string {
  try {
    return typeof input.normalize === "function" ? input.normalize("NFKC") : input;
  } catch {
    return input;
  }
}

/** The input without invisible characters (direction marks, zero-width spaces). */
export function removeInvisibleCharacters(input: string): string {
  return input.replace(INVISIBLE, "");
}

/** Just the characters that matter: digits and any "+", nothing between them. */
export function compactPhoneInput(input: string): string {
  return removeInvisibleCharacters(ordinaryCharacters(input)).replace(SEPARATORS, "");
}

/** "+233XXXXXXXXX" for any normal way of writing a Ghana number, or null. */
export function normalizeGhanaPhone(input: string): string | null {
  if (typeof input !== "string") return null;
  const compact = compactPhoneInput(input);

  const international = /^(?:\+|00)?233(?:0)?(\d{9})$/.exec(compact);
  if (international) return `+233${international[1]}`;

  const local = /^0(\d{9})$/.exec(compact);
  if (local) return `+233${local[1]}`;

  return null;
}

/** "+233548617924" -> "+233 54 861 7924", for showing a number back to someone. */
export function formatGhanaPhone(phone: string): string {
  const canonical = normalizeGhanaPhone(phone);
  if (!canonical) return phone;
  const s = canonical.slice(4);
  return `+233 ${s.slice(0, 2)} ${s.slice(2, 5)} ${s.slice(5)}`;
}

/** What to tell someone whose number didn't parse. */
export const GHANA_PHONE_EXAMPLE = "Enter a Ghana number, like 054 861 7924 or +233 54 861 7924.";
