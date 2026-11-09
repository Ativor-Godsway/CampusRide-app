import type { PrismaClient } from "@prisma/client";
import type { BalanceEntryKind } from "@rida/shared";
import { requestPlaceNames } from "../../routes/ridePins";
import { PAYSTACK_RECORDER } from "./payments";

/**
 * One driver's balance history, newest first: the commission of each
 * completed cash trip (CommissionLedger) and everything that took money off
 * (DriverCashPayment: payments, waivers, adjustments and reversals).
 * `effectPesewas` is what the entry did to the balance: + for commission,
 * − for a payment or waiver, + for a reversed payment.
 */
export interface LedgerEntry {
  id: string;
  kind: BalanceEntryKind;
  effectPesewas: number;
  at: string;
  /** COMMISSION: the trip and where it went. */
  rideId: string | null;
  route: string | null;
  /** PAYMENT: how ("CASH", "MOMO", "OTHER", "PAYSTACK"). */
  method: string | null;
  /** A Paystack payment's reference and the MoMo it came from. */
  reference: string | null;
  momoNetwork: string | null;
  phoneLast4: string | null;
  /** Gross the driver paid, and the fee in it (Paystack). */
  grossPesewas: number | null;
  feePesewas: number | null;
  /** This row cancels an earlier one. */
  isReversal: boolean;
  /** The admin's note or a waiver's reason; the reversal's reason. Admin site only. */
  note: string | null;
  /** The admin who recorded it, or "paystack". Admin site only. */
  recordedBy: string | null;
}

/** The newest `limit` entries. With `forAdmin`, notes and who recorded each row are included. */
export async function driverLedger(
  prisma: PrismaClient,
  driverUserId: string,
  options: { limit?: number; forAdmin?: boolean } = {},
): Promise<LedgerEntry[]> {
  const limit = options.limit ?? 100;
  const [commissions, credits] = await Promise.all([
    prisma.commissionLedger.findMany({
      where: { driverUserId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        amountPesewas: true,
        createdAt: true,
        rideId: true,
        ride: {
          select: {
            pickupLabel: true,
            dropoffLabel: true,
            pickupZone: { select: { name: true } },
            dropoffZone: { select: { name: true } },
          },
        },
      },
    }),
    prisma.driverCashPayment.findMany({
      where: { driverUserId },
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: { paystackPayment: { select: { reference: true, momoNetwork: true, phoneLast4: true, grossPesewas: true, feePesewas: true } } },
    }),
  ]);

  const admins = options.forAdmin
    ? await prisma.user.findMany({
        where: { id: { in: [...new Set(credits.map((c) => c.recordedBy).filter((id) => id !== PAYSTACK_RECORDER))] } },
        select: { id: true, name: true },
      })
    : [];
  const adminName = new Map(admins.map((a) => [a.id, a.name]));

  const entries: LedgerEntry[] = [
    ...commissions.map((c) => {
      const names = requestPlaceNames(c.ride, c.ride.pickupZone.name, c.ride.dropoffZone.name);
      return {
        id: c.id,
        kind: "COMMISSION" as const,
        effectPesewas: c.amountPesewas,
        at: c.createdAt.toISOString(),
        rideId: c.rideId,
        route: `${names.pickupPlaceName} → ${names.dropoffPlaceName}`,
        method: null,
        reference: null,
        momoNetwork: null,
        phoneLast4: null,
        grossPesewas: null,
        feePesewas: null,
        isReversal: false,
        note: null,
        recordedBy: null,
      };
    }),
    ...credits.map((c) => ({
      id: c.id,
      kind: c.kind,
      effectPesewas: -c.amountPesewas,
      at: c.paidAt.toISOString(),
      rideId: null,
      route: null,
      method: c.method,
      reference: c.paystackPayment?.reference ?? null,
      momoNetwork: c.paystackPayment?.momoNetwork ?? null,
      phoneLast4: c.paystackPayment?.phoneLast4 ?? null,
      grossPesewas: c.paystackPayment?.grossPesewas ?? null,
      feePesewas: c.paystackPayment?.feePesewas ?? null,
      isReversal: c.reversesId !== null,
      note: options.forAdmin ? (c.reversesId ? c.reversalReason : c.note) : null,
      recordedBy: options.forAdmin
        ? c.recordedBy === PAYSTACK_RECORDER
          ? "Paystack"
          : (adminName.get(c.recordedBy) ?? "Unknown admin")
        : null,
    })),
  ];
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
