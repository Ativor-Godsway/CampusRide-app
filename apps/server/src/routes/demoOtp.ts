import type { FastifyInstance } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient } from "@prisma/client";
import type { OtpService } from "../services/otp/OtpService";
import {
  requestDemoOtp,
  verifyDemoOtp,
  type DemoOtpLimits,
} from "../services/demoOtp/demoOtp";
import { MAX, object, text } from "../http/schemas";
import { clientIpForLimits } from "../rateLimit/reply";

/**
 * Public, namespaced OTP endpoints for the showcase demo site.
 *
 *   POST /demo/otp/send   { phone }        -> 200 { ok:true }  | 429 { ok:false, reason }
 *   POST /demo/otp/verify { phone, code }  -> 200 { ok:true }  | 4xx { ok:false, reason }
 *
 * Deliberately isolated from the real /auth/* OTP flow (separate DemoOtp store).
 * Delivery reuses the proven Moolre SMS path via the injected OtpService.
 */

// ── Tunable thresholds — adjust here before the demo, no code changes elsewhere.
const DEMO_OTP_LIMITS: DemoOtpLimits = {
  ttlMinutes: 5,
  codeLength: 6,
  maxVerifyAttempts: 5,
  perPhoneMinIntervalSeconds: 60, // max 1 send / 60s to a phone
  perPhoneMaxPerDay: 5, // max sends to one phone / rolling 24h
  perIpMaxPerHour: 10, // max sends from one IP / rolling hour
  globalMaxPerDay: 300, // global cap / rolling 24h — protects Moolre SMS balance
  retentionHours: 24, // rows swept after this (covers the longest window)
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function registerDemoOtpRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  otpService: OtpService,
): void {
  useRequestValidation(app);
  const deps = { prisma, otpService, limits: DEMO_OTP_LIMITS };

  // Not required by the schema: the demo site expects its own { ok, reason } answer.
  app.post("/demo/otp/send", { schema: { body: object({ phone: text(MAX.phone) }) } }, async (request, reply) => {
    const body = request.body as { phone?: unknown };
    if (!isNonEmptyString(body.phone)) {
      return reply.code(400).send({ ok: false, reason: "Phone number is required." });
    }

    // The real client address, unwound through Cloudflare and Render's proxies
    // only (lib/security.ts), never the leftmost X-Forwarded-For entry, which
    // a client can write itself to dodge the per-IP cap. Null when the
    // address isn't known: the per-IP cap is skipped, the others still apply.
    const ip = clientIpForLimits(request);
    const result = await requestDemoOtp(deps, { phone: body.phone, ip });

    // Log for monitoring — NEVER the code or any secret.
    request.log.info(
      { route: "demo.otp.send", ip, ok: result.ok, ...(result.ok ? {} : { status: result.status }) },
      "demo OTP send",
    );

    if (result.ok) {
      return reply.code(200).send({ ok: true });
    }
    return reply.code(result.status).send({ ok: false, reason: result.reason });
  });

  app.post(
    "/demo/otp/verify",
    { schema: { body: object({ phone: text(MAX.phone), code: text(MAX.otpCode) }) } },
    async (request, reply) => {
      const body = request.body as { phone?: unknown; code?: unknown };
      if (!isNonEmptyString(body.phone) || !isNonEmptyString(body.code)) {
        return reply.code(400).send({ ok: false, reason: "Phone and code are required." });
      }

      const result = await verifyDemoOtp(deps, { phone: body.phone, code: body.code });

      if (result.ok) {
        return reply.code(200).send({ ok: true });
      }
      return reply.code(result.status).send({ ok: false, reason: result.reason });
    },
  );
}
