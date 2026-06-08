import type { MoolreChannel } from "./constants";
import type { TxStatus } from "./constants";

export type { MoolreChannel as Channel, TxStatus };

export interface CollectParams {
  rideId: string;
  payerPhone: string;
  channel: MoolreChannel;
  /** Amount in integer pesewas — never a float. */
  amountPesewas: number;
  /** Caller-assigned, unique and deterministic per ride/leg (idempotency key). */
  externalRef: string;
}

export interface CollectResult {
  /** 1=Successful, 0=Pending, 2=Failed, 3=Unknown — see constants.ts. Collections are async; expect PENDING here and await the webhook/status check. */
  txstatus: TxStatus;
  externalRef: string;
  /** Provider's own transaction id, if returned. */
  providerRef?: string;
  raw?: unknown;
}

export interface ValidateRecipientParams {
  phone: string;
  channel: MoolreChannel;
}

export interface ValidateRecipientResult {
  /** The account holder name resolved by the provider. */
  accountName: string;
  raw?: unknown;
}

export interface DisburseParams {
  rideId: string;
  recipientPhone: string;
  channel: MoolreChannel;
  /** Amount in integer pesewas — never a float. */
  amountPesewas: number;
  /** Caller-assigned, unique and deterministic per ride/leg (idempotency key). */
  externalRef: string;
}

export interface DisburseResult {
  txstatus: TxStatus;
  externalRef: string;
  providerRef?: string;
  raw?: unknown;
}

export interface StatusResult {
  txstatus: TxStatus;
  externalRef: string;
  raw?: unknown;
}

/**
 * Swappable payment provider interface. All amounts are integer pesewas;
 * implementations convert to/at the provider's boundary only (see
 * amounts.ts for Moolre's decimal-GHS conversion).
 *
 * Idempotency: callers must pass a unique, deterministic `externalRef` per
 * ride/leg (e.g. `collect:{rideId}:{riderId}` / `disburse:{rideId}:{driverUserId}`)
 * so retries never double-charge or double-pay. Implementations should treat
 * a repeated `externalRef` as "return the existing result, do not re-initiate".
 */
export interface PaymentService {
  /** Initiates a collection (charge) from a rider. Returns a pending result; final status arrives via webhook or getStatus. */
  collect(params: CollectParams): Promise<CollectResult>;
  /** Resolves the account holder name for a recipient before disbursing. Throws if the account can't be validated. */
  validateRecipient(params: ValidateRecipientParams): Promise<ValidateRecipientResult>;
  /** Initiates a transfer (payout) to a driver. Uses the PRIVATE key — this moves money out. */
  disburse(params: DisburseParams): Promise<DisburseResult>;
  /** Looks up the current txstatus for a previously-issued externalRef. */
  getStatus(externalRef: string): Promise<StatusResult>;
}
