import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config";
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
import { registerAdminAccountDeletionRoutes } from "./adminAccountDeletion";
import { registerUssdRoutes } from "./ussd";
import { registerUploadRoutes } from "./uploads";
import { registerSafetyRoutes } from "./safety";
import { registerPlaceRoutes } from "./places";
import { registerPushRoutes } from "./push";
import { registerHealthRoutes } from "./health";
import { registerAppVersionRoutes } from "./appVersion";
import { registerLaunchRoutes } from "./launch";
import { registerNotificationRoutes } from "./notifications";
import { registerAdminPasskeyRoutes } from "./adminPasskeys";
import { registerAdminDashboardRoutes } from "./adminDashboard";
import { registerAdminInsightRoutes } from "./adminInsights";
import { registerAdminPeopleRoutes } from "./adminPeople";
import { installRateLimits } from "../rateLimit/http";
import { installErrorHandling } from "../http/errors";
import { useRequestValidation } from "../http/validation";

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
  // First: one error shape (no internals leaked) and request ids, then the
  // limits every route registered after it gets.
  useRequestValidation(app);
  installErrorHandling(app);
  installRateLimits(app);

  // /health (Render) and /health/ready (UptimeRobot): unlimited, see health.ts.
  registerHealthRoutes(app, prisma);
  // Public: whether this app version must update first (the "Time to update" screen).
  registerAppVersionRoutes(app);
  // Public launch countdown status, its signed-in form, and the admin Settings.
  registerLaunchRoutes(app, prisma);

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
  registerAdminAccountDeletionRoutes(app, prisma, deps.otpService);
  registerUssdRoutes(app, prisma, deps.ussdEnabled ?? config.enableUssd);
  registerUploadRoutes(app);
  registerSafetyRoutes(app, prisma);
  registerPlaceRoutes(app, prisma);
  registerPushRoutes(app, prisma);
  registerNotificationRoutes(app, prisma);
  registerAdminPasskeyRoutes(app, prisma);
  // The admin dashboard v2 (apps/admin): docs/admin-metrics.md.
  registerAdminDashboardRoutes(app, prisma);
  registerAdminInsightRoutes(app, prisma);
  registerAdminPeopleRoutes(app, prisma);
}
