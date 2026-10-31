import { CEDI_SIGN } from "@rida/shared";

/**
 * THE money formatter for the admin site. Amounts are stored as integer
 * pesewas; this turns them into "GH₵15", "GH₵12.75", "GH₵1,212" (no space,
 * no decimals for whole cedis, thousands grouped), "−GH₵3" for a reversal,
 * and "—" for no amount. Same rule as the apps' formatCedis, plus grouping.
 */
export function cedis(pesewas: number | null | undefined): string {
  if (pesewas === null || pesewas === undefined || !Number.isFinite(pesewas)) return "—";
  const negative = pesewas < 0;
  const abs = Math.abs(Math.round(pesewas));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = abs % 100;
  return `${negative ? "−" : ""}GH${CEDI_SIGN}${whole}${cents === 0 ? "" : `.${String(cents).padStart(2, "0")}`}`;
}

/** What someone types in a money field ("12.5", "GH₵12.50", "1,200") as pesewas; null if it isn't an amount. */
export function parseCedis(input: string): number | null {
  const cleaned = input.replace(/GH|₵|,|\s/gi, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** The amount as a plain number for a form field: 1275 -> "12.75", 1500 -> "15". */
export function cedisInput(pesewas: number): string {
  const whole = Math.floor(pesewas / 100);
  const cents = pesewas % 100;
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}

/** "92%", or "—" when there is nothing to divide by. */
export function percent(rate: number | null | undefined): string {
  return rate === null || rate === undefined || !Number.isFinite(rate) ? "—" : `${Math.round(rate * 100)}%`;
}

/** "1,234". */
export function count(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
