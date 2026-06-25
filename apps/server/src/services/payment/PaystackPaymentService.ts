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
 * Documented fallback provider — NOT the active implementation.
 *
 * Moolre is the active `PaymentService` (see services/active.ts). This
 * class is a skeleton only, sketching how a Paystack-based implementation
 * would map onto the same interface if Moolre integration needs to be
 * swapped out:
 *
 * - `collect`      -> Paystack Charge API (mobile money charge), returns
 *                      `pending`/`success`/`failed` -> map to txstatus 0/1/2.
 * - `validateRecipient` -> Paystack "Resolve Account Number" (bank) or
 *                      mobile-money equivalent for transfer recipients.
 * - `disburse`     -> Paystack Transfer Recipient + Transfer API.
 * - `getStatus`    -> Paystack "Verify Transaction" / "Fetch Transfer".
 *
 * Amount conversion would be pesewas -> kobo-equivalent (Paystack GHS amounts
 * are also in the smallest unit, pesewas, so no scaling is needed — unlike
 * Moolre's decimal-GHS strings).
 *
 * Every method below throws until a real implementation is written and
 * wired in services/active.ts behind a `PAYSTACK_ENABLED` flag, following
 * the same pattern as MoolrePaymentService/MnotifyOtpService.
 */
export class PaystackPaymentService implements PaymentService {
  constructor(private readonly secretKey: string) {
    void this.secretKey;
  }

  async collect(_params: CollectParams): Promise<CollectOutcome> {
    throw new Error("PaystackPaymentService.collect is not implemented — Moolre is the active provider");
  }

  async validateRecipient(_params: ValidateRecipientParams): Promise<ValidateRecipientResult> {
    throw new Error("PaystackPaymentService.validateRecipient is not implemented — Moolre is the active provider");
  }

  async disburse(_params: DisburseParams): Promise<DisburseResult> {
    throw new Error("PaystackPaymentService.disburse is not implemented — Moolre is the active provider");
  }

  async getStatus(_externalRef: string): Promise<StatusResult> {
    throw new Error("PaystackPaymentService.getStatus is not implemented — Moolre is the active provider");
  }
}
