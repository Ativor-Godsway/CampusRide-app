import { BlockList, isIP } from "node:net";

/**
 * Pure helpers for the transport-level security knobs wired up in index.ts.
 * Kept out of index.ts (and free of process.env reads) so both can be unit
 * tested against arbitrary inputs.
 */

/** What @fastify/cors and Socket.io accept for their `origin` option. */
export type CorsOrigin = string[] | boolean;

/**
 * Parses a comma-separated origin allowlist ("https://a.com, https://b.com").
 *
 * Each entry is normalized to the exact form a browser puts in its `Origin`
 * header, because @fastify/cors compares the two as plain strings:
 *
 *   - surrounding whitespace is trimmed, so "a, b" works as well as "a,b";
 *   - TRAILING SLASHES ARE STRIPPED. A browser never sends one ("https://x.com",
 *     not "https://x.com/"), but a value pasted out of a URL bar or a Render
 *     dashboard almost always has one, and "https://x.com/" silently matches
 *     nothing. This was a real outage: the allowlist looked correct in the
 *     dashboard and every request was still blocked.
 *
 * Blank entries are dropped so a trailing comma or an empty env var is
 * simply an empty allowlist rather than an origin named "".
 */
export function parseOriginAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/**
 * Every HTTP method a browser client (the admin site) uses. @fastify/cors
 * allows only GET, HEAD and POST unless told otherwise, so without this a
 * browser's preflight for PUT, PATCH or DELETE was refused and the admin
 * site's Save launch mode, launch notification switch, Remove passkey and
 * place edits never reached the server (2026-10-31). Add a method here when
 * a route the admin site calls uses a new one (cors.integration.test.ts
 * checks every method the admin site sends).
 */
export const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The @fastify/cors options for HTTP: one place, used by index.ts and the CORS tests alike. */
export function corsOptions(origin: CorsOrigin): { origin: CorsOrigin; methods: string[] } {
  return { origin, methods: [...CORS_METHODS] };
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
 * Addresses that are never a phone on the internet: this machine, private
 * networks (Render's internal load balancers), link-local, and carrier-grade
 * NAT space (which is translated before it reaches the internet). In
 * proxy-addr's keyword form where it has one.
 */
export const PRIVATE_PROXY_RANGES = ["loopback", "linklocal", "uniquelocal", "100.64.0.0/10"] as const;

/**
 * Cloudflare's edge. Every request to a Render service passes through it
 * (client -> Cloudflare -> Render's load balancer -> us), and each hop
 * appends to X-Forwarded-For. From https://www.cloudflare.com/ips/, checked
 * 2026-10-15; the list changes rarely. A missing range only means requests
 * through it skip the IP backstop (see isProxyAddress) — never a shared bucket.
 */
export const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** The production default for TRUST_PROXY: the proxies a Render service sits behind. */
export const RENDER_TRUSTED_PROXIES = [...PRIVATE_PROXY_RANGES, ...CLOUDFLARE_RANGES].join(",");

/**
 * Resolves Fastify's `trustProxy`.
 *
 * request.ip must be the CLIENT, because the IP backstop counts by it. Fastify
 * walks X-Forwarded-For from the right, skipping addresses it trusts, and
 * stops at the first one it doesn't: that is the client.
 *
 * It used to trust ONE hop. Behind Render the chain is client -> Cloudflare
 * -> Render's internal load balancer -> us, so one hop made request.ip the
 * load balancer's private address for every request — every "per-IP" limit
 * was one bucket shared by the whole app. Trusting the proxy RANGES instead
 * finds the client however many hops there are, and a client who sends its
 * own X-Forwarded-For only adds entries to the left of the ones the proxies
 * append, which the walk never reaches.
 *
 * TRUST_PROXY accepts:
 *   - unset     -> RENDER_TRUSTED_PROXIES in production, false elsewhere.
 *   - a number  -> that many trusted hops.
 *   - anything else -> an IP/CIDR list ("10.0.0.0/8,192.168.0.0/16").
 */
export function resolveTrustProxy(raw: string | undefined, nodeEnv: string): number | string | boolean {
  if (raw === undefined || raw.trim() === "") {
    return nodeEnv === "production" ? RENDER_TRUSTED_PROXIES : false;
  }
  const trimmed = raw.trim();
  const asNumber = Number(trimmed);
  if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
  return trimmed;
}

const proxyBlockList = (() => {
  const list = new BlockList();
  const add = (cidr: string) => {
    const [address, bits] = cidr.split("/") as [string, string];
    list.addSubnet(address, Number(bits), address.includes(":") ? "ipv6" : "ipv4");
  };
  // proxy-addr's keywords, spelled out.
  for (const cidr of ["127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"]) {
    add(cidr);
  }
  for (const cidr of [...PRIVATE_PROXY_RANGES, ...CLOUDFLARE_RANGES]) if (cidr.includes("/")) add(cidr);
  return list;
})();

/** "::ffff:10.1.2.3" -> "10.1.2.3": an IPv4 address seen through an IPv6 socket. */
export function plainIp(ip: string): string {
  return ip.startsWith("::ffff:") && ip.includes(".") ? ip.slice("::ffff:".length) : ip;
}

/**
 * True for an address that belongs to a proxy or a private network, not to a
 * client on the internet. Such an address can't be a person's — it is shared
 * by everyone behind that proxy — so it is never used as an IP-limit key.
 */
export function isProxyAddress(ip: string): boolean {
  const plain = plainIp(ip);
  const family = isIP(plain);
  if (family === 0) return true;
  return proxyBlockList.check(plain, family === 6 ? "ipv6" : "ipv4");
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

/**
 * Rate-limit `allowList` for a DEVELOPMENT server: requests from this machine
 * itself (loopback) are not limited, so the fake-rider simulator
 * (npm run sim:riders, docs/testing/SOLO_TESTING.md) can request a ride every
 * few seconds without tripping the 20-per-15-minutes ride-creation cap.
 *
 * Development only. Production never exempts anything, and neither does the
 * test suite (NODE_ENV=test), whose rate-limit tests inject from 127.0.0.1.
 * A phone on the Wi-Fi arrives from a LAN address, so it stays limited.
 */
export function isDevLoopbackExempt(ip: string, nodeEnv: string): boolean {
  if (nodeEnv !== "development") return false;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
