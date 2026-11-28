import type { Prisma, PrismaClient } from "@prisma/client";
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

// ─── Rate and waiver (2026-11-29) ────────────────────────────────────────

/** The rate before an admin sets one: 15%. */
export const DEFAULT_COMMISSION_RATE_BPS = 1500;
/** The rate an admin may set: 0% to 50%. */
export const COMMISSION_RATE_BOUNDS_BPS = { min: 0, max: 5000 } as const;

/**
 * How commission is charged: the rate, and whether it is waived (the
 * commission-free launch). A trip completed while waived (from `waivedFrom`)
 * owes nothing: its CommissionLedger row is kept with `waived = true`.
 */
export interface CommissionTerms {
  rateBps: number;
  waived: boolean;
  /** Midnight (Accra) of the waiver's first day; null while never waived. */
  waivedFrom: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export async function getCommissionTerms(prisma: PrismaClient): Promise<CommissionTerms> {
  const row = await prisma.commissionSetting.findUnique({
    where: { id: SETTING_ID },
    select: { rateBps: true, waived: true, waivedFrom: true, updatedAt: true, updatedBy: true },
  });
  if (!row) return { rateBps: DEFAULT_COMMISSION_RATE_BPS, waived: false, waivedFrom: null, updatedAt: null, updatedBy: null };
  return row;
}

/** How long completions reuse the terms they read (a save clears it at once on this server). */
const TERMS_TTL_MS = 30_000;
let termsCache: { at: number; value: Promise<CommissionTerms> } | null = null;

/** The terms in force, read at most every 30 s (each completed trip asks). */
export function currentCommissionTerms(prisma: PrismaClient, now: number = Date.now()): Promise<CommissionTerms> {
  if (termsCache && now - termsCache.at < TERMS_TTL_MS) return termsCache.value;
  const value = getCommissionTerms(prisma);
  termsCache = { at: now, value };
  value.catch(() => {
    if (termsCache?.value === value) termsCache = null;
  });
  return value;
}

/** Forget the cached terms (after a save; tests). */
export function clearCommissionTermsCache(): void {
  termsCache = null;
}

/** CampusRide's commission on a fare at a rate, rounded to the pesewa. */
export function commissionFor(farePesewas: number, rateBps: number): number {
  return Math.round((farePesewas * rateBps) / 10_000);
}

/** True when a trip completed at `at` owes nothing: the waiver is on and `at` is on or after its start. */
export function isWaivedAt(terms: Pick<CommissionTerms, "waived" | "waivedFrom">, at: Date): boolean {
  return terms.waived && (terms.waivedFrom === null || at.getTime() >= terms.waivedFrom.getTime());
}

/** Why a rate / waiver can't be saved, or null. `waivedFromDay` is "YYYY-MM-DD". */
export function commissionTermsProblem(input: { rateBps: number; waived: boolean; waivedFromDay: string | null }, now: Date = new Date()): string | null {
  const b = COMMISSION_RATE_BOUNDS_BPS;
  if (!Number.isInteger(input.rateBps) || input.rateBps < b.min || input.rateBps > b.max) return "The commission rate must be from 0% to 50%.";
  if (input.waived) {
    if (!input.waivedFromDay || !/^\d{4}-\d{2}-\d{2}$/.test(input.waivedFromDay) || Number.isNaN(Date.parse(`${input.waivedFromDay}T00:00:00Z`))) {
      return "Choose the day the waiver starts.";
    }
    if (Date.parse(`${input.waivedFromDay}T00:00:00Z`) > now.getTime()) return "The waiver can't start in the future: choose today or an earlier day.";
  }
  return null;
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * Saves the rate and the waiver, with an audit row, in one transaction.
 * Switching the waiver on (or moving its start) marks the trips completed
 * from the start day as waived — they are then owed by nobody, whatever
 * day it is switched on. Switching it off changes no past trip: trips from
 * then on are charged at the rate, automatically.
 */
export async function saveCommissionTerms(
  prisma: PrismaClient,
  input: { rateBps: number; waived: boolean; waivedFromDay: string | null },
  adminId: string,
): Promise<CommissionTerms> {
  const before = await getCommissionTerms(prisma);
  const waivedFrom = input.waived ? new Date(`${input.waivedFromDay}T00:00:00.000Z`) : before.waivedFrom;
  const describe = (t: { rateBps: number; waived: boolean; waivedFrom: Date | null }) =>
    `rate ${pct(t.rateBps)}, waived ${t.waived ? `on from ${t.waivedFrom?.toISOString().slice(0, 10) ?? "the start"}` : "off"}`;
  const data = { rateBps: input.rateBps, waived: input.waived, waivedFrom, updatedBy: adminId };
  const steps: Prisma.PrismaPromise<unknown>[] = [
    prisma.commissionSetting.upsert({ where: { id: SETTING_ID }, create: { id: SETTING_ID, ...data }, update: data }),
  ];
  if (input.waived && waivedFrom) {
    steps.push(prisma.commissionLedger.updateMany({ where: { createdAt: { gte: waivedFrom }, waived: false }, data: { waived: true } }));
    // The start moved later while waived: the days it no longer covers are owed again.
    if (before.waived && before.waivedFrom && before.waivedFrom < waivedFrom) {
      steps.push(
        prisma.commissionLedger.updateMany({ where: { createdAt: { gte: before.waivedFrom, lt: waivedFrom }, waived: true }, data: { waived: false } }),
      );
    }
  }
  steps.push(
    prisma.adminAuditLog.create({
      data: { actor: adminId, action: "commission.terms", target: SETTING_ID, reason: `${describe(before)} → ${describe({ ...input, waivedFrom })}` },
    }),
  );
  await prisma.$transaction(steps);
  clearCommissionTermsCache();
  return getCommissionTerms(prisma);
}
