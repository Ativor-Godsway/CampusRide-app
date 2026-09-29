/** The Ghana cedi sign, U+20B5. */
export const CEDI_SIGN = "₵";

/**
 * THE fare formatter for every screen that shows money (rider, driver and
 * admin apps): integer pesewas → "GH₵5", "GH₵5.50", "−GH₵2".
 *
 * Whole cedis drop the decimals (fares are usually round: GH₵5, GH₵15);
 * anything else shows exactly two. Amounts are always stored as integer
 * pesewas, so this never parses or rounds a float fare.
 */
export function formatCedis(pesewas: number): string {
  if (!Number.isFinite(pesewas)) return `GH${CEDI_SIGN}—`;
  const negative = pesewas < 0;
  const abs = Math.abs(Math.round(pesewas));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const amount = cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
  return `${negative ? "−" : ""}GH${CEDI_SIGN}${amount}`;
}

/**
 * The spoken form for screen readers: "5 cedis", "5 cedis 50 pesewas".
 * VoiceOver/TalkBack read "GH₵5" unpredictably ("G H cedi sign 5").
 */
export function spokenCedis(pesewas: number): string {
  if (!Number.isFinite(pesewas)) return "unknown amount";
  const negative = pesewas < 0;
  const abs = Math.abs(Math.round(pesewas));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const parts = [`${whole} ${whole === 1 ? "cedi" : "cedis"}`];
  if (cents > 0) parts.push(`${cents} ${cents === 1 ? "pesewa" : "pesewas"}`);
  return `${negative ? "minus " : ""}${parts.join(" ")}`;
}
