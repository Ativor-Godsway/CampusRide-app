import { describe, expect, it } from "vitest";
import {
  lastCreditText,
  DEFAULT_DEBT_LIMIT_PESEWAS,
  DEFAULT_WARNING_PERCENT,
  blocksGoingOnline,
  debtWarningText,
  feePercentText,
  parseFeePercent,
  paystackQuote,
  paystackQuoteText,
  showsDebtWarning,
  warningLevelPesewas,
  type CommissionRules,
} from "./commissionBalance";

const rules = (over: Partial<CommissionRules> = {}): CommissionRules => ({
  debtLimitPesewas: DEFAULT_DEBT_LIMIT_PESEWAS,
  warningPercent: DEFAULT_WARNING_PERCENT,
  enforcementEnabled: true,
  feeBps: 195,
  feeCapPesewas: null,
  ...over,
});

describe("paystackQuote (CampusRide receives the whole balance after the fee)", () => {
  it("adds nothing when the fee is 0", () => {
    expect(paystackQuote(8_500, 0, null)).toEqual({ owedPesewas: 8_500, feePesewas: 0, grossPesewas: 8_500 });
  });

  it("grosses up by the rate, rounding up to a pesewa", () => {
    // 8500 / (1 − 0.0195) = 8669.04… → 8670
    const q = paystackQuote(8_500, 195, null);
    expect(q).toEqual({ owedPesewas: 8_500, feePesewas: 170, grossPesewas: 8_670 });
    // What Paystack keeps (1.95% of the gross, rounded) leaves at least the balance.
    expect(q.grossPesewas - Math.round(q.grossPesewas * 0.0195)).toBeGreaterThanOrEqual(8_500);
  });

  it("never asks more than owed + cap when the fee is capped", () => {
    // Uncapped: 100000 / 0.9805 = 101988.78 → 101989, a fee of 1989. Cap GH₵10.
    expect(paystackQuote(100_000, 195, 1_000)).toEqual({ owedPesewas: 100_000, feePesewas: 1_000, grossPesewas: 101_000 });
  });

  it("leaves a small amount under the cap untouched by it", () => {
    expect(paystackQuote(8_500, 195, 1_000)).toEqual(paystackQuote(8_500, 195, null));
  });

  it("is all integers for awkward amounts", () => {
    for (const owed of [1, 7, 99, 1_234, 9_999, 123_457]) {
      const q = paystackQuote(owed, 250, 500);
      expect(Number.isInteger(q.grossPesewas)).toBe(true);
      expect(q.grossPesewas - q.owedPesewas).toBe(q.feePesewas);
      expect(q.feePesewas).toBeLessThanOrEqual(500);
    }
  });

  it("says it in one line", () => {
    expect(paystackQuoteText(paystackQuote(8_500, 195, null))).toBe("Owed GH₵85 + payment fee GH₵1.70 = Pay GH₵86.70");
  });
});

describe("going online and the warning", () => {
  it("blocks only with enforcement on and at the limit or above", () => {
    expect(blocksGoingOnline(10_000, rules())).toBe(true);
    expect(blocksGoingOnline(12_000, rules())).toBe(true);
    expect(blocksGoingOnline(9_999, rules())).toBe(false);
    expect(blocksGoingOnline(50_000, rules({ enforcementEnabled: false }))).toBe(false);
  });

  it("warns from 80% of the limit, with enforcement on", () => {
    expect(warningLevelPesewas(rules())).toBe(8_000);
    expect(showsDebtWarning(7_999, rules())).toBe(false);
    expect(showsDebtWarning(8_000, rules())).toBe(true);
    expect(showsDebtWarning(9_000, rules({ enforcementEnabled: false }))).toBe(false);
    expect(warningLevelPesewas({ debtLimitPesewas: 333, warningPercent: 50 })).toBe(167);
  });

  it("words the warning", () => {
    expect(debtWarningText(8_500, 10_000)).toBe("You owe GH₵85. Pay before GH₵100 to keep driving.");
    expect(debtWarningText(10_500, 10_000)).toBe("You owe GH₵105. Pay it to go online again.");
  });
});

describe("fee percent", () => {
  it("reads and writes basis points", () => {
    expect(parseFeePercent("1.95")).toBe(195);
    expect(parseFeePercent("1.5%")).toBe(150);
    expect(parseFeePercent("0")).toBe(0);
    expect(parseFeePercent("abc")).toBeNull();
    expect(parseFeePercent("1.955")).toBeNull();
    expect(feePercentText(195)).toBe("1.95%");
    expect(feePercentText(150)).toBe("1.5%");
    expect(feePercentText(105)).toBe("1.05%");
    expect(feePercentText(0)).toBe("0%");
  });
});

describe("lastCreditText (Balance's one line)", () => {
  const now = new Date(2026, 10, 9, 18, 0);
  it("says paid or waived, how much, and the day", () => {
    expect(lastCreditText({ kind: "PAYMENT", amountPesewas: 4020, at: new Date(2026, 10, 9, 10).toISOString() }, now)).toBe("Last paid GH₵40.20 · 9 Nov");
    expect(lastCreditText({ kind: "WAIVER", amountPesewas: 4020, at: new Date(2026, 9, 31, 10).toISOString() }, now)).toBe("Last waived GH₵40.20 · 31 Oct");
  });
  it("adds the year when it isn't this year", () => {
    expect(lastCreditText({ kind: "PAYMENT", amountPesewas: 100, at: new Date(2025, 11, 30).toISOString() }, now)).toBe("Last paid GH₵1 · 30 Dec 2025");
  });
});
