import { pesewasToGhs } from "./amounts";
import { COLLECTION_CHANNEL_CODE, TRANSFER_CHANNEL_CODE, TX_STATUS, type TxStatus } from "./constants";
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

const TYPE_MOBILE_MONEY = 1;
const ID_TYPE_EXTERNAL_REF = 1;

export interface MoolreConfig {
  /** `https://sandbox.moolre.com` for sandbox, `https://api.moolre.com` for live. Never hardcode. */
  baseUrl: string;
  /** X-API-USER header — username, sent on all calls. */
  apiUser: string;
  /**
   * X-API-PUBKEY header. Not currently sent by any call site — collection
   * was found to require the private key (X-API-KEY) instead, like every
   * other endpoint. Kept for any endpoint that's later found to legitimately
   * need the public key; never sent to sandbox (sandbox takes X-API-USER only).
   */
  publicKey: string;
  /** X-API-KEY header — sent on every live-mode call (collection, transfer/disbursement, validate-name). Moves money out; the most sensitive secret in the system. Never sent to sandbox. */
  privateKey: string;
  /** Moolre account number, sent on all calls. */
  accountNumber: string;
}

interface MoolreResponseShape {
  /** Moolre's response code, e.g. "TR099", "TP14", "TP13", "AIN01", "AIN04". */
  code?: string;
  status?: string;
  message?: string;
  txstatus?: number;
  // Moolre returns `data` as EITHER a nested object (status / validate /
  // transfer endpoints) OR a bare string — the collection TR099 settlement
  // uuid, e.g. "data":"ef3adeff-9b77-4d72-8d9e-cd53bf77f963" (confirmed
  // against a live collection). extractProviderRef() handles the string form.
  data?: string | { txstatus?: number; name?: string; accountname?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Body-level codes that mean "not a failure" even though the call isn't a definite success yet. */
const OK_CODES = new Set(["TR099", "TP14"]);
/** Body-level codes that are always a hard failure, regardless of `status`. */
const HARD_FAILURE_CODES = new Set(["TP13", "AIN01", "AIN04"]);

/**
 * Real payment integration via Moolre, behind the PaymentService interface.
 * Only instantiated when `config.moolre.enabled` is true (see
 * services/active.ts) — tests and local dev use DummyPaymentService instead,
 * so this code path never runs in the automated test suite. Verified via the
 * manual sandbox script (scripts/moolreSandbox.ts).
 */
export class MoolrePaymentService implements PaymentService {
  constructor(private readonly cfg: MoolreConfig) {}

  async collect(params: CollectParams): Promise<CollectOutcome> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      channel: COLLECTION_CHANNEL_CODE[params.channel],
      currency: "GHS",
      payer: params.payerPhone,
      amount: pesewasToGhs(params.amountPesewas),
      externalref: params.externalRef,
      accountnumber: this.cfg.accountNumber,
      ...(params.otpcode ? { otpcode: params.otpcode } : {}),
    };

    const data = await this.post("/open/transact/payment", body, { keyType: "private" });

    // post() already threw on any hard-failure code — only TR099 (USSD
    // prompt sent) or TP14 (OTP required, SMS sent) reach here.
    if (data.code === "TP14") {
      return { kind: "OTP_REQUIRED", externalRef: params.externalRef, raw: data };
    }
    return { kind: "PROMPT_SENT", externalRef: params.externalRef, providerTxId: extractProviderRef(data), code: data.code, raw: data };
  }

  async validateRecipient(params: ValidateRecipientParams): Promise<ValidateRecipientResult> {
    const body = {
      type: TYPE_MOBILE_MONEY,
      receiver: params.phone,
      channel: TRANSFER_CHANNEL_CODE[params.channel],
      currency: "GHS",
      accountnumber: this.cfg.accountNumber,
    };

    const data = await this.post("/open/transact/validate", body, { keyType: "private" });

    const d = dataObject(data);
    const accountName = d?.accountname ?? d?.name;
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

    const data = await this.post("/open/transact/transfer", body, { keyType: "private" });

    const txstatus = toTxStatus(data.txstatus ?? dataObject(data)?.txstatus, TX_STATUS.UNKNOWN);

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

    const data = await this.post("/open/transact/status", body, { keyType: "private" });

    const txstatus = toTxStatus(data.txstatus ?? dataObject(data)?.txstatus, TX_STATUS.UNKNOWN);

    return { txstatus, externalRef, raw: data };
  }

  /** True for sandbox.moolre.com, false for api.moolre.com (or any other live host). */
  private isSandbox(): boolean {
    return new URL(this.cfg.baseUrl).host.startsWith("sandbox.");
  }

  /**
   * SANDBOX AUTH QUIRK: sandbox.moolre.com only accepts X-API-USER — sending
   * X-API-KEY or X-API-PUBKEY at all (even empty) causes auth failures
   * (AIN01/AIN04). Live (api.moolre.com) requires X-API-USER plus the
   * appropriate key. Never logs header values.
   */
  private buildAuthHeaders(keyType: "private" | "public"): Record<string, string> {
    const headers: Record<string, string> = { "X-API-USER": this.cfg.apiUser };
    if (this.isSandbox()) {
      return headers;
    }
    if (keyType === "private") {
      if (!this.cfg.privateKey) {
        throw new Error("MOOLRE_PRIVATE_KEY is required for live Moolre calls (X-API-KEY) but is not set");
      }
      headers["X-API-KEY"] = this.cfg.privateKey;
    } else {
      if (!this.cfg.publicKey) {
        throw new Error("MOOLRE_PUBLIC_KEY is required for this live Moolre call (X-API-PUBKEY) but is not set");
      }
      headers["X-API-PUBKEY"] = this.cfg.publicKey;
    }
    return headers;
  }

  /**
   * POSTs to a Moolre endpoint and classifies the response body, not just
   * the HTTP status: Moolre returns HTTP 200 for body-level failures (e.g.
   * duplicate externalref, auth rejection), so those must be inspected
   * explicitly or they'd be silently treated as "pending". `status` is
   * normalized via String() because Moolre returns it inconsistently as
   * integer 1 or string "0".
   */
  private async post(
    path: string,
    body: Record<string, unknown>,
    opts: { keyType: "private" | "public" },
  ): Promise<MoolreResponseShape> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.buildAuthHeaders(opts.keyType),
    };

    const response = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as MoolreResponseShape;

    if (!response.ok) {
      throw new Error(`Moolre ${path} returned HTTP ${response.status}: ${JSON.stringify(data)}`);
    }

    const statusStr = data.status !== undefined ? String(data.status) : undefined;
    const code = typeof data.code === "string" ? data.code : undefined;
    const isOkCode = code !== undefined && OK_CODES.has(code);
    const isHardFailureCode = code !== undefined && HARD_FAILURE_CODES.has(code);

    if (isHardFailureCode || (statusStr !== "1" && !isOkCode)) {
      throw new Error(
        `Moolre ${path} failed: code=${code ?? "?"} status=${statusStr ?? "?"} message=${
          data.message ?? JSON.stringify(data)
        }`,
      );
    }

    console.log(`[MOOLRE] ${path} ok: code=${code ?? "?"} status=${statusStr ?? "?"} data=${JSON.stringify(data.data)}`);

    return data;
  }
}

function toTxStatus(value: unknown, fallback: TxStatus): TxStatus {
  if (value === TX_STATUS.SUCCESS || value === TX_STATUS.PENDING || value === TX_STATUS.FAILED || value === TX_STATUS.UNKNOWN) {
    return value;
  }
  return fallback;
}

/**
 * Narrows `data.data` to its object form (status / validate / transfer
 * endpoints). Returns undefined when Moolre sent the bare-string form (a
 * collection settlement uuid) — those callers read object fields, not the uuid.
 */
function dataObject(data: MoolreResponseShape): Record<string, unknown> | undefined {
  return typeof data.data === "object" && data.data !== null ? data.data : undefined;
}

function extractProviderRef(data: MoolreResponseShape): string | undefined {
  // Collection's TR099 returns the settlement uuid as a bare string in `data`
  // (confirmed live: "data":"ef3adeff-9b77-4d72-8d9e-cd53bf77f963"). Every
  // other endpoint nests the id inside an object instead.
  if (typeof data.data === "string") {
    return data.data.length > 0 ? data.data : undefined;
  }
  const id = data.data?.transactionid ?? data.data?.id;
  return typeof id === "string" ? id : typeof id === "number" ? String(id) : undefined;
}
