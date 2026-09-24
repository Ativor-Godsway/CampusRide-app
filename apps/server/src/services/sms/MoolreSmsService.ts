import { toMsisdn } from "../../lib/phone";
const SMS_SEND_PATH = "/open/sms/send";
const TYPE_SMS = 1;
const SMS_STATUS_SUCCESS = 1;

export interface MoolreSmsConfig {
  /** `https://sandbox.moolre.com` for sandbox, `https://api.moolre.com` for live. Same base URL as payments. */
  baseUrl: string;
  /** X-API-USER header — username, sent on all calls. */
  apiUser: string;
  /** X-API-VASKEY header — SMS (VAS) calls only. A separate key from the payment keys. Never log. */
  vasKey: string;
  /** Pre-registered, approved Moolre sender ID. */
  senderId: string;
}

interface MoolreSmsResponseShape {
  status?: number | string;
  [key: string]: unknown;
}

export interface SendMoolreSmsOptions {
  /** Prefixes the Moolre `ref` field (e.g. "otp", "ride") — purely for tracing in Moolre's dashboard. Defaults to "sms". */
  refPrefix?: string;
  fetchFn?: typeof fetch;
}

/**
 * Raw Moolre SMS (VAS) send — the transport logic shared by every SMS sender
 * in the app (OTP delivery, USSD ride-transition notifications). Originally
 * lived only inside MoolreOtpService with a hardcoded OTP message template;
 * lifted out here so any caller can send arbitrary text.
 */
export async function sendMoolreSms(
  cfg: MoolreSmsConfig,
  phone: string,
  message: string,
  options: SendMoolreSmsOptions = {},
): Promise<{ success: boolean }> {
  const { refPrefix = "sms", fetchFn = fetch } = options;
  const recipient = toMoolreRecipient(phone);
  const ref = `${refPrefix}:${recipient}:${Date.now()}`;

  const body = {
    type: TYPE_SMS,
    senderid: cfg.senderId,
    messages: [{ recipient, message, ref }],
  };

  const response = await fetchFn(`${cfg.baseUrl}${SMS_SEND_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-USER": cfg.apiUser,
      "X-API-VASKEY": cfg.vasKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return { success: false };
  }

  const data = (await response.json()) as MoolreSmsResponseShape;
  return { success: data.status === SMS_STATUS_SUCCESS || data.status === String(SMS_STATUS_SUCCESS) };
}

/**
 * Moolre SMS expects recipients as "233XXXXXXXXX" — country code, no leading
 * "+", no leading 0.
 *
 * This used to only strip a "+", which assumed every caller already held a
 * canonical "+233…" number. They do not: the auth routes store whatever the
 * user typed, so a rider who entered "0548608146" was sent to Moolre in that
 * local form.
 *
 * In practice Moolre ACCEPTS the local form and those messages are delivered
 * (verified in production) — so this is a correctness and consistency fix,
 * not a repair of a broken send. Reasons to normalize anyway:
 *
 *   - "233XXXXXXXXX" is the documented contract. Local-form acceptance is
 *     undocumented behaviour that could change under us, and it would change
 *     silently, on the login path.
 *   - `ref` (our idempotency key) is derived from the recipient, so the same
 *     person reached via two stored formats produced two different refs.
 *   - One canonical recipient makes delivery logs and support lookups match
 *     the number a human would search for.
 *
 * Anything that isn't a Ghanaian number falls back to the old strip-the-plus
 * behaviour rather than being dropped: an unusual emergency contact should
 * still get its best-effort attempt.
 */
function toMoolreRecipient(phone: string): string {
  return toMsisdn(phone) ?? (phone.startsWith("+") ? phone.slice(1) : phone);
}
