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

/** Moolre SMS expects recipients without a leading "+" (e.g. "233XXXXXXXXX"). */
function toMoolreRecipient(phone: string): string {
  return phone.startsWith("+") ? phone.slice(1) : phone;
}
