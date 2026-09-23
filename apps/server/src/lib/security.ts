/**
 * Pure helpers for the transport-level security knobs wired up in index.ts.
 * Kept out of index.ts (and free of process.env reads) so both can be unit
 * tested against arbitrary inputs.
 */

/** What @fastify/cors and Socket.io accept for their `origin` option. */
export type CorsOrigin = string[] | boolean;

/**
 * Parses a comma-separated origin allowlist ("https://a.com, https://b.com").
 * Blank entries are dropped so a trailing comma or an empty env var is
 * simply an empty allowlist rather than an origin named "".
 */
export function parseOriginAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Resolves the CORS `origin` option.
 *
 * Previously this reflected ANY origin whenever the allowlist was unset,
 * which let any website on the internet make credentialed cross-origin calls
 * to the API from a victim's browser. Now an empty allowlist means:
 *   - production        -> `false`, i.e. no browser origin is granted access.
 *   - anything else     -> `true`, reflect any origin, for local dev/tooling.
 *
 * Native apps (Expo/React Native) send no Origin header at all, so CORS never
 * applies to them and `false` does not affect the rider or driver apps — it
 * only closes the browser attack surface.
 */
export function resolveCorsOrigin(allowlist: string[], nodeEnv: string): CorsOrigin {
  if (allowlist.length > 0) return allowlist;
  return nodeEnv !== "production";
}

/**
 * Resolves Fastify's `trustProxy`.
 *
 * `true` (the previous value) trusts the ENTIRE X-Forwarded-For chain, so a
 * client can spoof its own IP by sending the header — which silently defeats
 * every per-IP rate limit in config.rateLimit. A hop count trusts only the
 * proxies we actually run behind (Render terminates TLS at exactly one), so
 * request.ip is the address that proxy observed and cannot be forged.
 *
 * TRUST_PROXY accepts:
 *   - unset     -> 1 in production (Render's single hop), false elsewhere.
 *   - a number  -> that many trusted hops.
 *   - anything else -> passed through to Fastify as an IP/CIDR allowlist
 *                      (e.g. "10.0.0.0/8,192.168.0.0/16").
 */
export function resolveTrustProxy(raw: string | undefined, nodeEnv: string): number | string | boolean {
  if (raw === undefined || raw.trim() === "") {
    return nodeEnv === "production" ? 1 : false;
  }
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return trimmed;
}

/**
 * Fastify's `trustProxy` type accepts a string/array/boolean or a predicate,
 * but not a hop count, even though the underlying proxy-addr supports one.
 * Convert a hop count into the equivalent predicate: proxy-addr calls it per
 * address in the X-Forwarded-For chain with a 0-based `hop`, so trusting
 * `hop < hops` trusts exactly the nearest `hops` proxies and no further.
 *
 * 0 hops means "trust nothing", which is `false` rather than a predicate
 * that is never true, so Fastify skips the forwarded-header parsing entirely.
 */
export function toFastifyTrustProxy(
  value: number | string | boolean,
): string | boolean | ((address: string, hop: number) => boolean) {
  if (typeof value !== "number") return value;
  if (value <= 0) return false;
  return (_address: string, hop: number) => hop < value;
}
