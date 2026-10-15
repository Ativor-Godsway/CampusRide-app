import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { APP_NAME, config } from "../config";
import type { OtpService } from "../services/otp/OtpService";
import type { PaymentService } from "../services/payment/PaymentService";
import { registerAuthRoutes } from "./auth";
import { registerDemoOtpRoutes } from "./demoOtp";
import { registerWebhookRoutes } from "./webhooks";
import { registerZoneRoutes } from "./zones";
import { registerRideRoutes } from "./rides";
import { registerRatingRoutes } from "./ratings";
import { registerDriverRoutes } from "./driver";
import { registerAdminRoutes } from "./admin";
import { registerUssdRoutes } from "./ussd";
import { registerUploadRoutes } from "./uploads";
import { registerSafetyRoutes } from "./safety";
import { registerPlaceRoutes } from "./places";
import { registerPushRoutes } from "./push";
import { installRateLimits } from "../rateLimit/http";

export interface RouteDeps {
  otpService: OtpService;
  paymentService: PaymentService;
  /** Defaults to config; tests switch the dormant channels on to see every route. */
  paymentsEnabled?: boolean;
  ussdEnabled?: boolean;
}

/**
 * Every HTTP route the server answers, in one place: index.ts registers
 * exactly this, and the authorization tests register the same thing, so a
 * route can't exist in production without the permission tests (and
 * docs/security/route-inventory.md) knowing about it.
 */
export function registerAllRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  deps: RouteDeps,
): void {
  // First: it gives every route registered after it its limits.
  installRateLimits(app);

  // Unlimited: Render's health check and UptimeRobot poll it.
  app.get("/health", { config: { limits: false } }, async () => {
    return { status: "ok", app: APP_NAME };
  });

  registerAuthRoutes(app, prisma, deps.otpService);
  registerDemoOtpRoutes(app, prisma, deps.otpService);
  registerWebhookRoutes(
    app,
    prisma,
    deps.paymentService,
    config.moolre.webhookSecret,
    deps.paymentsEnabled ?? config.moolre.paymentsEnabled,
  );
  registerZoneRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  registerRatingRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  registerUssdRoutes(app, prisma, deps.ussdEnabled ?? config.enableUssd);
  registerUploadRoutes(app);
  registerSafetyRoutes(app, prisma);
  registerPlaceRoutes(app, prisma);
  registerPushRoutes(app, prisma);
}
