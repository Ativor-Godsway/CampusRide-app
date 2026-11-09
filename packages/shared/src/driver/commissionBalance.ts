/**
 * What a driver owes CampusRide, and paying it (server, driver app and admin
 * site use these). Riders pay drivers in cash, so each completed cash trip
 * leaves the driver owing CampusRide's 15%. All money is integer pesewas.
 *
 *   balance = commissions − payments − waivers (− adjustments)
 *
 * Paying goes through Paystack, which keeps a fee. The driver adds that fee
 * so CampusRide still receives the whole balance (paystackQuote).
 */
import { formatCedis } from "../format/currency";

/** Until an admin changes it (admin site, Settings): GH₵100. */
export const DEFAULT_DEBT_LIMIT_PESEWAS = 10_000;
/** The warning comes at this share of the limit, until an admin changes it. */
export const DEFAULT_WARNING_PERCENT = 80;

/** The bounds the admin site accepts for each rule. */
export const COMMISSION_RULE_BOUNDS = {
  /** GH₵1 to GH₵10,000. */
  debtLimitPesewas: { min: 100, max: 1_000_000 },
  warningPercent: { min: 1, max: 100 },
  /** 0% to 10%, in basis points (195 = 1.95%). */
  feeBps: { min: 0, max: 1_000 },
  /** 1 pesewa to GH₵1,000; or no cap. */
  feeCapPesewas: { min: 1, max: 100_000 },
} as const;

export interface CommissionRules {
  debtLimitPesewas: number;
  warningPercent: number;
  /** Off (the commission-free launch): commission piles up, nobody is ever blocked. */
  enforcementEnabled: boolean;
  /** Paystack's fee, in basis points. */
  feeBps: number;
  /** Paystack's fee cap in pesewas, or null for none. */
  feeCapPesewas: number | null;
}

/** The balance from which the warning shows: warningPercent of the limit, rounded up to a pesewa. */
export function warningLevelPesewas(rules: Pick<CommissionRules, "debtLimitPesewas" | "warningPercent">): number {
  return Math.ceil((rules.debtLimitPesewas * rules.warningPercent) / 100);
}

/**
 * True when going online must be refused: enforcement is on and the driver
 * owes the limit or more. Only ever asked when going online, never during
 * a trip (the server checks for one first).
 */
export function blocksGoingOnline(
  balancePesewas: number,
  rules: Pick<CommissionRules, "debtLimitPesewas" | "enforcementEnabled">,
): boolean {
  return rules.enforcementEnabled && balancePesewas > 0 && balancePesewas >= rules.debtLimitPesewas;
}

/**
 * True when the driver app shows the "pay before the limit" warning: the
 * balance has reached the warning level and enforcement is on. During the
 * commission-free launch (enforcement off) nobody is warned, since nobody
 * will be blocked; the Balance screen still shows what is owed.
 */
export function showsDebtWarning(balancePesewas: number, rules: CommissionRules): boolean {
  return rules.enforcementEnabled && balancePesewas > 0 && balancePesewas >= warningLevelPesewas(rules);
}

/** "You owe GH₵85. Pay before GH₵100 to keep driving." */
export function debtWarningText(balancePesewas: number, debtLimitPesewas: number): string {
  if (balancePesewas >= debtLimitPesewas) {
    return `You owe ${formatCedis(balancePesewas)}. Pay it to go online again.`;
  }
  return `You owe ${formatCedis(balancePesewas)}. Pay before ${formatCedis(debtLimitPesewas)} to keep driving.`;
}

export interface PaystackQuote {
  /** What is cleared off the balance: the whole balance. */
  owedPesewas: number;
  /** The payment fee the driver adds. */
  feePesewas: number;
  /** What the driver pays: owed + fee. */
  grossPesewas: number;
}

/**
 * What the driver pays so CampusRide receives the whole `owedPesewas` after
 * Paystack's fee: gross = ceil(owed ÷ (1 − rate)), but never more than
 * owed + cap when the fee is capped (at that size Paystack takes only the
 * cap). Integer arithmetic only.
 */
export function paystackQuote(owedPesewas: number, feeBps: number, feeCapPesewas: number | null): PaystackQuote {
  const owed = Math.max(0, Math.round(owedPesewas));
  const bps = Math.min(Math.max(0, Math.round(feeBps)), 9_999);
  let gross = bps === 0 ? owed : Math.ceil((owed * 10_000) / (10_000 - bps));
  if (feeCapPesewas !== null && feeCapPesewas >= 0) gross = Math.min(gross, owed + Math.round(feeCapPesewas));
  return { owedPesewas: owed, feePesewas: gross - owed, grossPesewas: gross };
}

/** "Owed GH₵85 + payment fee GH₵1.69 = Pay GH₵86.69" */
export function paystackQuoteText(quote: PaystackQuote): string {
  return `Owed ${formatCedis(quote.owedPesewas)} + payment fee ${formatCedis(quote.feePesewas)} = Pay ${formatCedis(quote.grossPesewas)}`;
}

/** "1.95%" from basis points. */
export function feePercentText(feeBps: number): string {
  const whole = Math.floor(feeBps / 100);
  const rest = feeBps % 100;
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}%`;
}

/** "1.95" → 195; null for anything that isn't a percentage with at most two decimals. */
export function parseFeePercent(input: string): number | null {
  const m = /^\s*(\d{1,2})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** The MoMo networks a driver can pay from. Telecel was Vodafone (Paystack still calls it "vod"). */
export const MOMO_NETWORKS = [
  { value: "MTN", label: "MTN" },
  { value: "TELECEL", label: "Telecel" },
  { value: "AIRTELTIGO", label: "AirtelTigo" },
] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number]["value"];

/** What a commission payment is doing now, as the driver app shows it. */
export type CommissionPaymentStatus = "PENDING" | "SUCCESS" | "FAILED" | "ABANDONED" | "MISMATCH";

/** What each kind of balance entry is called in the driver app and the admin site. */
export type BalanceEntryKind = "COMMISSION" | "PAYMENT" | "WAIVER" | "ADJUSTMENT";
