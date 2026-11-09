import { createHmac, timingSafeEqual } from "node:crypto";
import type { MomoNetwork } from "@rida/shared";
import { config } from "../../config";

/**
 * The few Paystack calls the commission payments need
 * (https://paystack.com/docs/api): a mobile-money charge, the OTP some
 * networks ask for, the hosted checkout page as the fallback, and the
 * verify endpoint, which is the only thing ever trusted to say "paid".
 * Amounts are in pesewas (Paystack's subunit for GHS). The secret key is
 * sent only in the Authorization header and never logged; nor are phone
 * numbers.
 */

/** Paystack's code for each network. Telecel was Vodafone and is still "vod". */
export const PAYSTACK_PROVIDER: Record<MomoNetwork, string> = {
  MTN: "mtn",
  TELECEL: "vod",
  AIRTELTIGO: "atl",
};

/** What a charge or OTP submission came back with. */
export type ChargeAnswer =
  /** Paystack answered. `status` is its data.status: "pay_offline", "send_otp", "pending", "success", "failed"… */
  | { kind: "answered"; status: string; message: string | null }
  /** Paystack said no (status false, a 4xx): the charge didn't start. */
  | { kind: "refused"; message: string }
  /** No usable answer (timeout, 5xx, network): it may or may not have started. */
  | { kind: "unreachable" };

export type CheckoutAnswer = { kind: "created"; url: string } | { kind: "refused"; message: string } | { kind: "unreachable" };

/** Paystack's verify endpoint, for one reference. */
export type VerifyAnswer =
  | {
      kind: "found";
      /** "success", "failed", "abandoned", "ongoing", "pending", "reversed"… */
      status: string;
      reference: string;
      amountPesewas: number;
      currency: string;
      feesPesewas: number | null;
      paidAt: Date | null;
      message: string | null;
    }
  | { kind: "not_found" }
  | { kind: "unreachable" };

export interface PaystackClient {
  /** False without PAYSTACK_SECRET_KEY: paying is unavailable. */
  readonly configured: boolean;
  chargeMomo(input: { reference: string; amountPesewas: number; email: string; phone: string; network: MomoNetwork }): Promise<ChargeAnswer>;
  submitOtp(reference: string, otp: string): Promise<ChargeAnswer>;
  initializeCheckout(input: { reference: string; amountPesewas: number; email: string }): Promise<CheckoutAnswer>;
  verify(reference: string): Promise<VerifyAnswer>;
}

/** True when `signature` (the x-paystack-signature header) is the HMAC-SHA512 of the raw body with the secret key. */
export function isValidPaystackSignature(rawBody: string, signature: unknown, secretKey: string): boolean {
  if (!secretKey || typeof signature !== "string" || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  const expected = createHmac("sha512", secretKey).update(rawBody, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

const TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;
type HttpResult = { kind: "json"; httpStatus: number; body: Json } | { kind: "unreachable" };

/** The real client, against api.paystack.co (or PAYSTACK_BASE_URL). */
export function createPaystackClient(cfg: { secretKey: string; baseUrl: string } = config.paystack): PaystackClient {
  async function call(method: "GET" | "POST", path: string, body?: Json): Promise<HttpResult> {
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.secretKey}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 500) return { kind: "unreachable" };
      const parsed = (await res.json().catch(() => null)) as unknown;
      if (!parsed || typeof parsed !== "object") return { kind: "unreachable" };
      return { kind: "json", httpStatus: res.status, body: parsed as Json };
    } catch {
      return { kind: "unreachable" };
    }
  }

  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

  function chargeAnswer(r: HttpResult): ChargeAnswer {
    if (r.kind === "unreachable") return r;
    const data = (r.body.data ?? {}) as Json;
    if (r.body.status === true && typeof data.status === "string") {
      return { kind: "answered", status: data.status, message: text(data.display_text) ?? text(data.gateway_response) ?? text(data.message) };
    }
    // A declined charge also comes back as a 4xx with data.status "failed".
    if (typeof data.status === "string" && data.status === "failed") {
      return { kind: "answered", status: "failed", message: text(data.gateway_response) ?? text(data.message) ?? text(r.body.message) };
    }
    if (r.httpStatus >= 400 && r.httpStatus < 500) return { kind: "refused", message: text(r.body.message) ?? "Paystack refused the payment" };
    return { kind: "unreachable" };
  }

  return {
    configured: cfg.secretKey.length > 0,

    async chargeMomo(input) {
      return chargeAnswer(
        await call("POST", "/charge", {
          email: input.email,
          amount: input.amountPesewas,
          currency: "GHS",
          reference: input.reference,
          mobile_money: { phone: input.phone, provider: PAYSTACK_PROVIDER[input.network] },
          metadata: { purpose: "driver_commission" },
        }),
      );
    },

    async submitOtp(reference, otp) {
      return chargeAnswer(await call("POST", "/charge/submit_otp", { reference, otp }));
    },

    async initializeCheckout(input) {
      const r = await call("POST", "/transaction/initialize", {
        email: input.email,
        amount: input.amountPesewas,
        currency: "GHS",
        reference: input.reference,
        channels: ["mobile_money"],
        metadata: { purpose: "driver_commission" },
      });
      if (r.kind === "unreachable") return r;
      const url = (r.body.data as Json | undefined)?.authorization_url;
      if (r.body.status === true && typeof url === "string" && url.startsWith("https://")) return { kind: "created", url };
      if (r.httpStatus >= 400) return { kind: "refused", message: text(r.body.message) ?? "Paystack refused the payment" };
      return { kind: "unreachable" };
    },

    async verify(reference) {
      const r = await call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
      if (r.kind === "unreachable") return r;
      const data = r.body.data as Json | undefined;
      if (r.body.status !== true || !data || typeof data !== "object") {
        return r.httpStatus === 400 || r.httpStatus === 404 ? { kind: "not_found" } : { kind: "unreachable" };
      }
      const paidAt = typeof data.paid_at === "string" ? new Date(data.paid_at) : null;
      return {
        kind: "found",
        status: typeof data.status === "string" ? data.status : "unknown",
        reference: typeof data.reference === "string" ? data.reference : "",
        amountPesewas: typeof data.amount === "number" ? data.amount : Number.NaN,
        currency: typeof data.currency === "string" ? data.currency : "",
        feesPesewas: typeof data.fees === "number" ? data.fees : null,
        paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
        message: text(data.gateway_response),
      };
    },
  };
}
