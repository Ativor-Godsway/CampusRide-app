import type { PrismaClient } from "@prisma/client";
import {
  COMMISSION_RULE_BOUNDS,
  DEFAULT_DEBT_LIMIT_PESEWAS,
  DEFAULT_WARNING_PERCENT,
  type CommissionRules,
} from "@rida/shared";
import { config } from "../../config";

/** The one CommissionSetting row's id. */
const SETTING_ID = "commission";

export interface CommissionSettings extends CommissionRules {
  /** When an admin last saved them, and who; null while the defaults apply. */
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** The rules before any admin saves them: GH₵100, 80%, enforcement off, the Paystack fee from env. */
export function defaultCommissionRules(): CommissionRules {
  return {
    debtLimitPesewas: DEFAULT_DEBT_LIMIT_PESEWAS,
    warningPercent: DEFAULT_WARNING_PERCENT,
    enforcementEnabled: false,
    feeBps: config.paystack.feeBps,
    feeCapPesewas: config.paystack.feeCapPesewas,
  };
}

/** The rules in force: the saved row, or the defaults when there is none. */
export async function getCommissionSettings(prisma: PrismaClient): Promise<CommissionSettings> {
  const row = await prisma.commissionSetting.findUnique({ where: { id: SETTING_ID } });
  if (!row) return { ...defaultCommissionRules(), updatedAt: null, updatedBy: null };
  return {
    debtLimitPesewas: row.debtLimitPesewas,
    warningPercent: row.warningPercent,
    enforcementEnabled: row.enforcementEnabled,
    feeBps: row.feeBps,
    feeCapPesewas: row.feeCapPesewas,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
  };
}

/** Why a set of rules can't be saved, or null. */
export function commissionRulesProblem(rules: CommissionRules): string | null {
  const b = COMMISSION_RULE_BOUNDS;
  const within = (v: number, r: { min: number; max: number }) => Number.isInteger(v) && v >= r.min && v <= r.max;
  if (!within(rules.debtLimitPesewas, b.debtLimitPesewas)) return "The limit must be from GH₵1 to GH₵10,000.";
  if (!within(rules.warningPercent, b.warningPercent)) return "The warning level must be from 1% to 100% of the limit.";
  if (!within(rules.feeBps, b.feeBps)) return "The Paystack fee must be from 0% to 10%.";
  if (rules.feeCapPesewas !== null && !within(rules.feeCapPesewas, b.feeCapPesewas)) return "The fee cap must be from GH₵0.01 to GH₵1,000, or none.";
  return null;
}

/** Saves the rules with an audit row saying what changed, in one transaction. */
export async function saveCommissionSettings(prisma: PrismaClient, rules: CommissionRules, adminId: string): Promise<CommissionSettings> {
  const before = await getCommissionSettings(prisma);
  const data = {
    debtLimitPesewas: rules.debtLimitPesewas,
    warningPercent: rules.warningPercent,
    enforcementEnabled: rules.enforcementEnabled,
    feeBps: rules.feeBps,
    feeCapPesewas: rules.feeCapPesewas,
    updatedBy: adminId,
  };
  const describe = (r: CommissionRules) =>
    `limit ${r.debtLimitPesewas}, warning ${r.warningPercent}%, enforcement ${r.enforcementEnabled ? "on" : "off"}, fee ${r.feeBps} bps, cap ${r.feeCapPesewas ?? "none"}`;
  await prisma.$transaction([
    prisma.commissionSetting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data }),
    prisma.adminAuditLog.create({
      data: { actor: adminId, action: "commission.settings", target: SETTING_ID, reason: `${describe(before)} → ${describe(rules)}`.slice(0, 1000) },
    }),
  ]);
  return getCommissionSettings(prisma);
}
