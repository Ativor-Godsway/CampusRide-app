import { pesewasToGhs } from "./amounts";
import { COLLECTION_CHANNEL_CODE, TRANSFER_CHANNEL_CODE, TX_STATUS, type TxStatus } from "./constants";
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

const TYPE_MOBILE_MONEY = 1;
const ID_TYPE_EXTERNAL_REF = 1;

export interface MoolreConfig {
  /** `https://sandbox.moolre.com` for sandbox, `https://api.moolre.com` for live. Never hardcode. */
  baseUrl: string;
  /** X-API-USER header — username, sent on all calls. */
  apiUser: string;
  /** X-API-PUBKEY header — collection calls only. */
  publicKey: string;
  /** X-API-KEY header — transfer/disbursement + validate-name. Moves money out; the most sensitive secret in the system. */
  privateKey: string;
  /** Moolre account number, sent on all calls. */
  accountNumber: string;
}

interface MoolreResponseShape {
  /** Moolre's response code, e.g. "OTP_REQ", "payment-requested", "TX0001", "400_INSUFFICIENT_BALANCE". */
  code?: string;
  status?: string;
  txstatus?: number;
  data?: { txstatus?: number; name?: string; accountname?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Real payment integration via Moolre, behind the PaymentService interface.
 * Only instantiated when `config.moolre.enabled` is true (see
 * services/active.ts) — tests and local dev use DummyPaymentService instead,
 * so this code path never runs in the automated test suite. Verified via the
 * manual sandbox script (scripts/moolreSandbox.ts).
 */
export class MoolrePaymentService implements PaymentService {
  constructor(private readonly cfg: MoolreConfig) {}

  async collect(params: CollectParams): Promise<CollectResult> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      channel: COLLECTION_CHANNEL_CODE[params.channel],
      currency: "GHS",
      payer: params.payerPhone,
      amount: pesewasToGhs(params.amountPesewas),
      externalref: params.externalRef,
      accountnumber: this.cfg.accountNumber,
    };

    const data = await this.post("/open/transact/payment", body, { usePublicKey: true });

    // Collection is async by nature: an OTP prompt, "payment-requested", or
    // "pending" response all mean "awaiting confirmation via webhook/status
    // check" — never a definite outcome at this point. Only a response that
    // explicitly carries txstatus=2 (FAILED) is a definite failure here.
    const txstatus = toTxStatus(data.txstatus ?? data.data?.txstatus, TX_STATUS.PENDING);

    return {
      txstatus,
      externalRef: params.externalRef,
      providerRef: extractProviderRef(data),
      raw: data,
    };
  }

  async validateRecipient(params: ValidateRecipientParams): Promise<ValidateRecipientResult> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      receiver: params.phone,
      channel: TRANSFER_CHANNEL_CODE[params.channel],
      currency: "GHS",
      accountnumber: this.cfg.accountNumber,
    };

    const data = await this.post("/open/transact/validate", body, { usePublicKey: false });

    const accountName = data.data?.accountname ?? data.data?.name;
    if (typeof accountName !== "string" || accountName.length === 0) {
      throw new Error(`Moolre validate returned no account name: ${JSON.stringify(data)}`);
    }

    return { accountName, raw: data };
  }

  async disburse(params: DisburseParams): Promise<DisburseResult> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      channel: TRANSFER_CHANNEL_CODE[params.channel],
      currency: "GHS",
      amount: pesewasToGhs(params.amountPesewas),
      receiver: params.recipientPhone,
      externalref: params.externalRef,
      accountnumber: this.cfg.accountNumber,
    };

    const data = await this.post("/open/transact/transfer", body, { usePublicKey: false });

    const txstatus = toTxStatus(data.txstatus ?? data.data?.txstatus, TX_STATUS.UNKNOWN);

    return {
      txstatus,
      externalRef: params.externalRef,
      providerRef: extractProviderRef(data),
      raw: data,
    };
  }

  async getStatus(externalRef: string): Promise<StatusResult> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      idtype: ID_TYPE_EXTERNAL_REF,
      id: externalRef,
      accountnumber: this.cfg.accountNumber,
    };

    const data = await this.post("/open/transact/status", body, { usePublicKey: false });

    const txstatus = toTxStatus(data.txstatus ?? data.data?.txstatus, TX_STATUS.UNKNOWN);

    return { txstatus, externalRef, raw: data };
  }

  /**
   * POSTs to a Moolre endpoint with the correct key for the operation.
   * Collection uses X-API-PUBKEY; everything else (transfer, validate,
   * status) uses X-API-KEY (the private key). X-API-USER is sent on every
   * call. Never logs header values.
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    opts: { usePublicKey: boolean },
  ): Promise<MoolreResponseShape> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-API-USER": this.cfg.apiUser,
    };
    headers[opts.usePublicKey ? "X-API-PUBKEY" : "X-API-KEY"] = opts.usePublicKey
      ? this.cfg.publicKey
      : this.cfg.privateKey;

    const response = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as MoolreResponseShape;

    if (!response.ok) {
      throw new Error(`Moolre ${path} returned HTTP ${response.status}: ${JSON.stringify(data)}`);
    }

    return data;
  }
}

function toTxStatus(value: unknown, fallback: TxStatus): TxStatus {
  if (value === TX_STATUS.SUCCESS || value === TX_STATUS.PENDING || value === TX_STATUS.FAILED || value === TX_STATUS.UNKNOWN) {
    return value;
  }
  return fallback;
}

function extractProviderRef(data: MoolreResponseShape): string | undefined {
  const id = data.data?.transactionid ?? data.data?.id;
  return typeof id === "string" ? id : typeof id === "number" ? String(id) : undefined;
}
