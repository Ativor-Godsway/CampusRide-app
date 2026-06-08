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
