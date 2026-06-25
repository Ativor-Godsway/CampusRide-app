import { TX_STATUS } from "./constants";
import type {
  CollectOutcome,
  CollectParams,
  DisburseParams,
  DisburseResult,
  PaymentService,
  StatusResult,
  ValidateRecipientParams,
  ValidateRecipientResult,
} from "./PaymentService";

/**
 * In-memory, no-network payment provider used by the automated test suite
 * and local dev (mirrors DummyOtpService's role for mNotify).
 *
 * - `collect` returns PROMPT_SENT (the no-OTP path), matching Moolre's real
 *   async collection flow — tests simulate the provider confirming via a
 *   fake webhook.
 * - `disburse` and `validateRecipient` succeed immediately.
 * - Idempotency: repeated calls with the same externalRef return the
 *   originally-stored result rather than re-initiating.
 */
export class DummyPaymentService implements PaymentService {
  /** Idempotent cache of collect()'s initiate-call outcome (kind-based). */
  private readonly collectOutcomes = new Map<string, CollectOutcome>();
  /** Simulated final settlement status, read by getStatus/markCollected/markFailed and disburse — independent of collect()'s outcome kind. */
  private readonly settlement = new Map<string, DisburseResult>();

  async collect(params: CollectParams): Promise<CollectOutcome> {
    const existing = this.collectOutcomes.get(params.externalRef);
    if (existing) return existing;

    const outcome: CollectOutcome = {
      kind: "PROMPT_SENT",
      externalRef: params.externalRef,
      providerTxId: `dummy-collect-${params.externalRef}`,
    };
    this.collectOutcomes.set(params.externalRef, outcome);
    if (!this.settlement.has(params.externalRef)) {
      this.settlement.set(params.externalRef, {
        txstatus: TX_STATUS.PENDING,
        externalRef: params.externalRef,
        providerRef: outcome.providerTxId,
      });
    }
    return outcome;
  }

  async validateRecipient(params: ValidateRecipientParams): Promise<ValidateRecipientResult> {
    return { accountName: `Dummy Account (${params.phone})` };
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    const existing = this.settlement.get(params.externalRef);
    if (existing) return existing;

    const result: DisburseResult = {
      txstatus: TX_STATUS.SUCCESS,
      externalRef: params.externalRef,
      providerRef: `dummy-disburse-${params.externalRef}`,
    };
    this.settlement.set(params.externalRef, result);
    return result;
  }

  async getStatus(externalRef: string): Promise<StatusResult> {
    const existing = this.settlement.get(externalRef);
    return {
      txstatus: existing?.txstatus ?? TX_STATUS.UNKNOWN,
      externalRef,
    };
  }

  /** Test helper: simulates the provider confirming a collection (txstatus -> SUCCESS). */
  markCollected(externalRef: string): void {
    const existing = this.settlement.get(externalRef);
    this.settlement.set(externalRef, {
      txstatus: TX_STATUS.SUCCESS,
      externalRef,
      providerRef: existing?.providerRef ?? `dummy-collect-${externalRef}`,
    });
  }

  /** Test helper: simulates the provider failing a collection (txstatus -> FAILED). */
  markFailed(externalRef: string): void {
    const existing = this.settlement.get(externalRef);
    this.settlement.set(externalRef, {
      txstatus: TX_STATUS.FAILED,
      externalRef,
      providerRef: existing?.providerRef ?? `dummy-collect-${externalRef}`,
    });
  }
}
