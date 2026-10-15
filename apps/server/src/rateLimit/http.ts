import type { FastifyInstance, onRequestHookHandler, preHandlerHookHandler } from "fastify";
import { config } from "../config";
import { isDevLoopbackExempt } from "../lib/security";
import { requireAuth } from "../middleware/auth";
import { limiter, type LimitCheck } from "./limiter";
import { RULES, type LimitRule } from "./rules";
import { clientIpForLimits, logClientIpCheckOnce, sendRateLimited } from "./reply";

/**
 * What a route declares in `config.limits`:
 *
 * - `false`: no HTTP limit at all. For SOS (an emergency is never refused)
 *   and /health (Render and UptimeRobot poll it).
 * - `{ user: [...] }`: extra per-account limits on a signed-in route, on top
 *   of the per-account default.
 *
 * Limits keyed by something only the handler knows (a phone number in the
 * body, a refresh token's login) are applied inside the handler.
 */
export type RouteLimits = false | { user?: readonly LimitRule[] };

declare module "fastify" {
  interface FastifyContextConfig {
    limits?: RouteLimits;
  }
}

/**
 * Gives every route registered after it its HTTP limits:
 *
 * - signed-in route (requireAuth in its preHandler): the account's default
 *   (RULES.userDefault) plus any `config.limits.user`, counted by account id
 *   once requireAuth has identified the caller. Never by IP — a hostel on one
 *   Wi-Fi is hundreds of accounts.
 * - public route: the generous per-IP backstop (RULES.ipPublic), only when
 *   the real client IP is known (clientIpForLimits).
 *
 * Development requests from this Mac itself are not limited (the simulator).
 */
export function installRateLimits(app: FastifyInstance): void {
  if (config.nodeEnv === "production") {
    const check: onRequestHookHandler = async (request) => logClientIpCheckOnce(request, app.log);
    app.addHook("onRequest", check);
  }

  app.addHook("onRoute", (route) => {
    const limits = route.config?.limits;
    if (limits === false) return;

    const existing = route.preHandler === undefined ? [] : [route.preHandler].flat();
    const signedIn = existing.includes(requireAuth as preHandlerHookHandler);
    const extra = limits?.user ?? [];

    const limit: preHandlerHookHandler = async (request, reply) => {
      if (isDevLoopbackExempt(request.ip, config.nodeEnv)) return;
      const checks: LimitCheck[] = [];
      if (signedIn) {
        const userId = request.user?.userId;
        if (!userId) return; // requireAuth has already answered
        checks.push({ rule: RULES.userDefault, subject: userId });
        for (const rule of extra) checks.push({ rule, subject: userId });
      } else {
        const ip = clientIpForLimits(request);
        if (ip) checks.push({ rule: RULES.ipPublic, subject: ip });
      }
      const outcome = await limiter.consume(checks);
      if (!outcome.ok) return sendRateLimited(reply, outcome.retryAfterMs);
    };

    route.preHandler = [...existing, limit];
  });
}
