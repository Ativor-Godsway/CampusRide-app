import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { rateLimitedBody } from "@rida/shared";
import { config } from "../config";
import { isProxyAddress, plainIp } from "../lib/security";

/**
 * The one 429 every route sends: a Retry-After header in whole seconds, and
 * `{ error, code: "RATE_LIMITED", retryAfterSeconds }` with a sentence the
 * apps can show as-is ("Too many attempts. Try again in 3 minutes.").
 */
export function sendRateLimited(reply: FastifyReply, retryAfterMs: number) {
  const body = rateLimitedBody(retryAfterMs / 1000);
  return reply.code(429).header("retry-after", String(body.retryAfterSeconds)).send(body);
}

let warnedProxyIp = false;

/**
 * The client's address for IP limits, or null when it can't be trusted to
 * be one person's. In production, an address that belongs to a proxy or a
 * private network means the proxy chain wasn't unwound (see
 * lib/security.ts#resolveTrustProxy): counting by it would put everyone
 * behind that proxy in one bucket — the exact lockout these limits exist to
 * prevent — so the IP backstop is skipped instead, and the people-keyed
 * limits still apply.
 */
export function clientIpForLimits(
  request: FastifyRequest,
  nodeEnv: string = config.nodeEnv,
): string | null {
  const ip = plainIp(request.ip);
  if (nodeEnv === "production" && isProxyAddress(ip)) {
    if (!warnedProxyIp) {
      warnedProxyIp = true;
      request.log.warn(
        { event: "client_ip_unresolved" },
        "request.ip is a proxy or private address: the per-IP backstop is OFF until TRUST_PROXY is fixed (people-keyed limits still apply)",
      );
    }
    return null;
  }
  return ip;
}

let checkedForwarding = false;

/**
 * Once per process, on the first proxied request in production: says in the
 * log whether the real client address was found behind Render's proxies —
 * WITHOUT logging any address. `resolvedToClient: true` is what you want to
 * see after a deploy (docs/security/rate-limits.md).
 */
export function logClientIpCheckOnce(request: FastifyRequest, log: FastifyBaseLogger): void {
  if (checkedForwarding) return;
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded === undefined) return;
  checkedForwarding = true;
  const chain = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)
    .split(",")
    .map((s) => s.trim());
  const ip = plainIp(request.ip);
  const cf = request.headers["cf-connecting-ip"];
  log.info(
    {
      event: "client_ip_check",
      forwardedEntries: chain.length,
      resolvedToClient: !isProxyAddress(ip),
      matchesCloudflareClientIp: typeof cf === "string" ? plainIp(cf) === ip : null,
    },
    "Client IP resolution behind the proxy",
  );
}
