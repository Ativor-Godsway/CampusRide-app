/**
 * A Ghana licence plate as it's typed: capitals, the region letters, the
 * number, and the year after a dash — "gr123424" becomes "GR 1234-24".
 * Ghana's pattern is 2–3 letters, up to 4 digits, then a 2-digit year (or a
 * letter on older plates). Anything that doesn't fit is left as typed, in
 * capitals, so an unusual plate can still be entered.
 */
export function formatPlateInput(raw: string): string {
  const compact = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const match = compact.match(/^([A-Z]{1,3})(\d{0,4})(\d{0,2}|[A-Z])$/);
  if (!match) return raw.toUpperCase();
  const [, letters, number, year] = match;
  let out = letters!;
  if (number) out += ` ${number}`;
  if (year) out += `-${year}`;
  return out;
}
