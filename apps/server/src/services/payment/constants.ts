/**
 * CampusRide payment constants — named, never magic numbers inline.
 */

/** Mobile money networks we support. */
export type MoolreChannel = "MTN" | "TELECEL" | "AT";

/**
 * Moolre channel codes.
 *
 * FLAGGED DISCREPANCY (from Moolre's docs, confirm before going live):
 * the **collection** ("payment") endpoint documents MTN as channel 13,
 * while the **transfer** (disbursement) and validate-name endpoints
 * document MTN as channel 1. Telecel (6) and AT (7) are consistent across
 * both. We therefore keep two separate maps below and select the correct
 * one per endpoint — never share a single "channel code" constant across
 * collection and transfer.
 */
export const COLLECTION_CHANNEL_CODE: Record<MoolreChannel, string> = {
  MTN: "13",
  TELECEL: "6",
  AT: "7",
};

export const TRANSFER_CHANNEL_CODE: Record<MoolreChannel, number> = {
  MTN: 1,
  TELECEL: 6,
  AT: 7,
};

/**
 * Moolre `txstatus` values, per the docs (this rule is stated twice in
 * Moolre's documentation, so it gets its own named helper):
 *
 *   1 = Successful
 *   0 = Pending
 *   2 = Failed
 *   3 = Unknown
 *
 * NEVER treat anything other than 2 as a definite failure. Pending (0) and
 * Unknown (3) both mean "keep checking via the status endpoint / await the
 * webhook" — never auto-fail, never retry-charge, never assume success or
 * failure for those two values.
 */
export const TX_STATUS = {
  SUCCESS: 1,
  PENDING: 0,
  FAILED: 2,
  UNKNOWN: 3,
} as const;

export type TxStatus = (typeof TX_STATUS)[keyof typeof TX_STATUS];

/** The ONLY condition that should ever be treated as a definite failure. */
export function isDefiniteFailure(txstatus: number): boolean {
  return txstatus === TX_STATUS.FAILED;
}

/** The ONLY condition that should ever be treated as a definite success. */
export function isDefiniteSuccess(txstatus: number): boolean {
  return txstatus === TX_STATUS.SUCCESS;
}
