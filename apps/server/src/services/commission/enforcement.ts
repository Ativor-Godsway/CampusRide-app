import type { PrismaClient } from "@prisma/client";
import { blocksGoingOnline, formatCedis } from "@rida/shared";
import { driverBalance } from "../admin/cash";
import { getCommissionSettings } from "./settings";

export interface CommissionBlock {
  owedPesewas: number;
  limitPesewas: number;
  message: string;
}

/**
 * Why this driver may not go online, or null: enforcement is on (admin
 * site, Settings) and they owe the limit or more. Only asked when going
 * online; the caller lets a driver with a trip under way through.
 */
export async function commissionBlock(prisma: PrismaClient, driverUserId: string): Promise<CommissionBlock | null> {
  const settings = await getCommissionSettings(prisma);
  if (!settings.enforcementEnabled) return null;
  const { balancePesewas } = await driverBalance(prisma, driverUserId);
  if (!blocksGoingOnline(balancePesewas, settings)) return null;
  return {
    owedPesewas: balancePesewas,
    limitPesewas: settings.debtLimitPesewas,
    message: `You owe CampusRide ${formatCedis(balancePesewas)} in commission. Pay it to go online again.`,
  };
}
