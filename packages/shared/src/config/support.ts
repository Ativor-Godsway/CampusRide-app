import { normalizeGhanaPhone } from "../phone/ghanaPhone";

/**
 * "Call support" in the rider and driver apps' Account tab. The number comes
 * from the server (GET /app/config, Render variable SUPPORT_PHONE) so it can
 * change without an app update; this built-in one is used until the server
 * answers, or when it can't be reached.
 */
export const DEFAULT_SUPPORT_PHONE = "+233548608146";

/** Public, no login: the settings the apps read from the server. */
export const APP_CONFIG_PATH = "/app/config";

/** What GET /app/config answers. */
export interface AppConfig {
  /** Canonical "+233…" number the apps' "Call support" dials. */
  supportPhone: string;
}

/**
 * A support number from the server or a Render variable, as the canonical
 * "+233…" form — or the built-in number when it is missing or not a Ghana
 * number, so "Call support" always dials something real.
 */
export function supportPhoneFrom(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SUPPORT_PHONE;
  return normalizeGhanaPhone(value) ?? DEFAULT_SUPPORT_PHONE;
}

/** The support number in an answer from GET /app/config (anything else: the built-in one). */
export function supportPhoneFromConfig(data: unknown): string {
  const value = data && typeof data === "object" ? (data as { supportPhone?: unknown }).supportPhone : undefined;
  return supportPhoneFrom(value);
}
