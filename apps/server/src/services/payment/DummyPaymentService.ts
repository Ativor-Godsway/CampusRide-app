import { TX_STATUS } from "./constants";
import type {
  CollectParams,
  CollectResult,
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
 * - `collect` returns PENDING, matching Moolre's real async collection flow
 *   — tests simulate the provider confirming via a fake webhook.
 * - `disburse` and `validateRecipient` succeed immediately.
 * - Idempotency: repeated calls with the same externalRef return the
 *   originally-stored result rather than re-initiating.
 */
export class DummyPaymentService implements PaymentService {
  private readonly results = new Map<string, CollectResult | DisburseResult>();

  async collect(params: CollectParams): Promise<CollectResult> {
    const existing = this.results.get(params.externalRef);
    if (existing) return existing as CollectResult;

    const result: CollectResult = {
      txstatus: TX_STATUS.PENDING,
      externalRef: params.externalRef,
      providerRef: `dummy-collect-${params.externalRef}`,
    };
    this.results.set(params.externalRef, result);
    return result;
  }

  async validateRecipient(params: ValidateRecipientParams): Promise<ValidateRecipientResult> {
    return { accountName: `Dummy Account (${params.phone})` };
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    const existing = this.results.get(params.externalRef);
    if (existing) return existing as DisburseResult;

    const result: DisburseResult = {
      txstatus: TX_STATUS.SUCCESS,
      externalRef: params.externalRef,
      providerRef: `dummy-disburse-${params.externalRef}`,
    };
    this.results.set(params.externalRef, result);
    return result;
  }

  async getStatus(externalRef: string): Promise<StatusResult> {
    const existing = this.results.get(externalRef);
    return {
      txstatus: existing?.txstatus ?? TX_STATUS.UNKNOWN,
      externalRef,
    };
  }

  /** Test helper: simulates the provider confirming a collection (txstatus -> SUCCESS). */
  markCollected(externalRef: string): void {
    const existing = this.results.get(externalRef);
    this.results.set(externalRef, {
      txstatus: TX_STATUS.SUCCESS,
      externalRef,
      providerRef: existing?.providerRef ?? `dummy-collect-${externalRef}`,
    });
  }

  /** Test helper: simulates the provider failing a collection (txstatus -> FAILED). */
  markFailed(externalRef: string): void {
    const existing = this.results.get(externalRef);
    this.results.set(externalRef, {
      txstatus: TX_STATUS.FAILED,
      externalRef,
      providerRef: existing?.providerRef ?? `dummy-collect-${externalRef}`,
    });
  }
}
