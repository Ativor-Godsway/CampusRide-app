/** Thrown by the webhook route when the `secret` field is missing or doesn't match MOOLRE_WEBHOOK_SECRET. */
export class InvalidWebhookSecretError extends Error {
  constructor() {
    super("Webhook secret missing or invalid");
    this.name = "InvalidWebhookSecretError";
  }
}

/** Thrown when a webhook references an externalref that has no matching Payment row. */
export class UnknownPaymentReferenceError extends Error {
  readonly externalRef: string;

  constructor(externalRef: string) {
    super(`No Payment found for externalref ${externalRef}`);
    this.name = "UnknownPaymentReferenceError";
    this.externalRef = externalRef;
  }
}

/**
 * Thrown when an otpcode is submitted but there's no AWAITING_OTP Payment row
 * to confirm it against — either no row exists for this externalref, or the
 * row is in some other state (PENDING/SUCCESS/FAILED). Never calls Moolre in
 * this case.
 */
export class NoAwaitingOtpPaymentError extends Error {
  readonly externalRef: string;

  constructor(externalRef: string) {
    super(`No AWAITING_OTP Payment found for externalref ${externalRef}`);
    this.name = "NoAwaitingOtpPaymentError";
    this.externalRef = externalRef;
  }
}
