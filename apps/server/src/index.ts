// First: error reporting (Sentry) starts before Fastify and Prisma load, so
// it can trace them. A no-op without SENTRY_DSN (lib/monitoring.ts).
import "./instrument";
import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import { Server as SocketServer } from "socket.io";
import { config } from "./config";
import { prisma } from "./db/prisma";
import { assertDatabaseAllowedForEnv } from "./db/dbHostGuard";
import {
  parseOriginAllowlist,
  resolveCorsOrigin,
  resolveTrustProxy,
  toFastifyTrustProxy,
} from "./lib/security";
import { processTimeouts } from "./services/ride/timeouts";
import {
  assertOtpServiceAllowedInProduction,
  otpService,
  paymentService,
  routeService,
} from "./services/active";
import { registerAllRoutes } from "./routes";
import { checkPushReceipts } from "./services/push/pushService";
import { checkCloudinaryAtStartup } from "./services/uploads/cloudinaryConfig";
import { initRideSocket } from "./realtime/rideSocket";
import { checkDeployEnv, checkProductionEnv } from "./lib/productionEnv";
import { resolveAppMinVersions } from "./lib/appMinVersions";
import { SOCKET_MAX_PAYLOAD_BYTES, serverOptions } from "./http/serverOptions";
import { createShutdown, installSignalHandlers } from "./lib/shutdown";
import { installFatalHandlers, onFatal } from "./lib/fatal";
import { logger } from "./lib/logger";
import { flushMonitoring, monitoringEnabled, reportError } from "./lib/monitoring";
import { alerts, noteDatabaseError } from "./lib/alerts";
import { MoolreOtpService } from "./services/otp/MoolreOtpService";
import { createBalanceCheck } from "./services/sms/moolreBalance";
import { loadTestOtpCode } from "./services/auth/loadTestOtp";
import { purgeDeletedAccounts } from "./services/auth/deleteAccount";
import { startReviewDemo } from "./services/reviewDemo/simulation";
import { reviewDemoConfig } from "./services/reviewDemo/config";

// From the very first line: an error nothing caught is logged and ends the
// process (Render restarts it), never left to run in an unknown state.
installFatalHandlers();

// 15s was too aggressive for Neon's pooled connection budget alongside
// request traffic; 30s still keeps the 90s dispatch/decision timeouts
// responsive (worst case +30s) while halving the steady-state query load.
const TIMEOUT_POLL_INTERVAL_MS = 30_000;

// Push receipts are only ready ~15 minutes after a send (services/push), so a
// slow sweep is plenty; it also deletes tokens Expo reports as unregistered.
const PUSH_RECEIPT_POLL_INTERVAL_MS = 5 * 60_000;

// The Moolre SMS balance is checked a minute after startup, then every 6 hours.
const SMS_BALANCE_FIRST_CHECK_MS = 60_000;
const SMS_BALANCE_INTERVAL_MS = 6 * 60 * 60_000;

// Closed accounts whose retention period has ended are erased hourly
// (services/auth/deleteAccount.ts); a day late at worst would still be fine.
const ACCOUNT_PURGE_INTERVAL_MS = 60 * 60_000;

export { paymentService, routeService, otpService };

async function bootstrap() {
  // Fail loud before binding a port: a LOCAL server must never come up against
  // the live database. db/prisma.ts enforces this at connection construction
  // too, but say it here as well so the refusal is the first thing in the log
  // rather than a stack trace from an import.
  assertDatabaseAllowedForEnv(config.databaseUrl, config.nodeEnv, "server startup");

  // Fail loud before binding a port: a production server that cannot deliver
  // login OTPs is not serviceable (see services/active.ts).
  assertOtpServiceAllowedInProduction(otpService, config.nodeEnv);

  // trustProxy: requests reach us through Cloudflare and Render's load
  // balancer, so the socket IP is a proxy's. Trusting exactly those proxy
  // address ranges makes request.ip the real client (the IP backstop counts
  // by it) however many hops there are, and never lets a client pick its own
  // "IP" with a forged X-Forwarded-For. See lib/security.ts#resolveTrustProxy.
  const trustProxy = resolveTrustProxy(config.trustProxy, config.nodeEnv);
  // Scrubbed logs, a 64 KB body limit, random request ids (http/serverOptions.ts).
  const app = Fastify({ ...serverOptions(), trustProxy: toFastifyTrustProxy(trustProxy) });
  if (config.nodeEnv === "production" && typeof trustProxy === "number") {
    app.log.warn(
      { trustProxy },
      "TRUST_PROXY is a hop count. Behind Render (Cloudflare + a load balancer) that resolves to a proxy, " +
        "so the per-IP backstop is switched off. Delete TRUST_PROXY on Render to use the default.",
    );
  }

  // Fail loud before binding a port: a production server missing a required
  // setting (or with a weak JWT_SECRET) never takes traffic. Only variable
  // NAMES are logged, never values. See lib/productionEnv.ts for the list.
  const deployProblem = checkDeployEnv(process.env);
  if (deployProblem) throw new Error(`Refusing to start: ${deployProblem}`);
  if (config.nodeEnv === "production") {
    const { errors, warnings } = checkProductionEnv(process.env);
    for (const warning of warnings) app.log.warn({ event: "production_env_warning" }, warning);
    if (errors.length > 0) {
      for (const error of errors) app.log.error({ event: "production_env_error" }, error);
      throw new Error(`Refusing to start: ${errors.length} required production setting(s) missing or invalid — see the lines above`);
    }
  } else if (config.adminPhoneAllowlist.phones.length === 0) {
    app.log.warn("ADMIN_PHONE_ALLOWLIST is empty: outside production any ADMIN account may use the admin site");
  }

  // A forced-update setting that can't be used blocks nobody (lib/appMinVersions.ts): say which.
  for (const name of resolveAppMinVersions(process.env).invalid) {
    app.log.warn({ event: "app_min_version_invalid" }, `${name} is not a version like 1.2.0 (or an https link): ignored, nobody is blocked by it`);
  }

  // Security headers (HSTS, X-Content-Type-Options, frame-ancestors denial,
  // Referrer-Policy, and friends) — the API previously sent none at all.
  // contentSecurityPolicy is off: this service returns JSON, never HTML, so a
  // CSP protects nothing here while breaking nothing is not guaranteed.
  // crossOriginEmbedderPolicy is likewise unnecessary for a pure API.
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    // 180 days, on every subdomain. Render serves the API over HTTPS only,
    // so there is no plaintext listener for this to lock clients out of.
    hsts: { maxAge: 15_552_000, includeSubDomains: true, preload: false },
  });

  // CORS: an explicit allowlist (CORS_ALLOWED_ORIGINS, falling back to the
  // older DEMO_OTP_CORS_ORIGINS). When it is empty we now DENY all browser
  // origins in production instead of reflecting whatever origin asked —
  // reflect-any is limited to non-production. Native apps (Expo/React Native)
  // send no Origin header, so none of this affects the rider/driver apps.
  const corsAllowlist = parseOriginAllowlist(config.corsAllowedOrigins);
  const corsOrigin = resolveCorsOrigin(corsAllowlist, config.nodeEnv);

  // Always state the resolved allowlist at boot. A CORS rejection is INVISIBLE
  // server-side — @fastify/cors blocks by omitting Access-Control-Allow-Origin,
  // so the request still returns 200 with its body and the browser is what
  // discards it. Without this line the logs show nothing but healthy traffic
  // while every browser client is broken.
  app.log.info(
    { corsAllowlist, nodeEnv: config.nodeEnv },
    `CORS allowlist resolved (${corsAllowlist.length} origin(s))`,
  );

  if (corsAllowlist.length === 0) {
    if (config.nodeEnv === "production") {
      app.log.warn(
        "CORS_ALLOWED_ORIGINS is EMPTY in production — NO browser origin can call this API, " +
          "so the admin site will fail on every request while this server keeps returning 200. " +
          "Set CORS_ALLOWED_ORIGINS to a comma-separated list of origins with no trailing slash, " +
          "e.g. https://campusride-admin.onrender.com. Native rider/driver apps send no Origin " +
          "header and are unaffected.",
      );
    } else {
      app.log.warn(
        "CORS_ALLOWED_ORIGINS is unset — reflecting any browser origin. This is permitted outside production only.",
      );
    }
  }
  await app.register(cors, { origin: corsOrigin });
  // Parser for application/x-www-form-urlencoded, scoped to that
  // Content-Type only — Fastify dispatches by exact header match, so this
  // never touches the built-in application/json parser every other route
  // uses. Moolre's USSD callback (POST /ussd/callback) is supposed to send
  // genuine form-urlencoded, but in practice sends a raw JSON string under
  // this Content-Type — so JSON.parse is tried first, falling back to real
  // form decoding (URLSearchParams) only if that throws. Subsumes
  // @fastify/formbody, which had no JSON-detection and would otherwise
  // decode Moolre's JSON blob as a single urlencoded key with an empty value.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const parsed = JSON.parse(body as string);
        if (parsed !== null && typeof parsed === "object") {
          return done(null, parsed);
        }
      } catch {
        // Not JSON — fall through to real form decoding below.
      }
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerAllRoutes(app, prisma, { otpService, paymentService });

  // app.server is the underlying http.Server — attach Socket.io to it directly
  await app.ready();

  // Socket.io gets the SAME origin policy as HTTP. It used to be an
  // unconditional "*", which meant any web page could open an authenticated
  // ride socket in a visitor's browser regardless of the HTTP CORS rules.
  const io = new SocketServer(app.server, {
    cors: { origin: corsOrigin },
    // No socket message needs more than a few hundred bytes; a bigger one
    // closes that connection instead of being read.
    maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES,
  });

  io.on("connection", (socket) => {
    app.log.info(`[Socket.io] client connected: ${socket.id}`);
    socket.on("disconnect", () => {
      app.log.info(`[Socket.io] client disconnected: ${socket.id}`);
    });
  });

  initRideSocket(io, prisma);

  await app.listen({ port: config.port, host: "0.0.0.0" });

  await prisma.$connect();
  app.log.info("Database connected");

  // One sweep straight away rather than 30 s from now: rides whose waiting
  // time ran out while the server was down (a deploy, a crash) are settled
  // at once. Nothing about a ride's timing lives in memory, so this is all a
  // restart needs (docs/architecture/in-memory-state.md).
  await processTimeouts(prisma, new Date(), { logger: app.log }).catch((err) => {
    app.log.error({ err }, "Startup timeout sweep failed");
  });
  if (loadTestOtpCode()) {
    app.log.warn(
      { event: "load_test_otp" },
      "LOAD TEST MODE: every login code is the fixed LOAD_TEST_OTP_CODE (local database only, never production)",
    );
  }
  app.log.info(
    { sentry: monitoringEnabled() },
    monitoringEnabled() ? "Error reporting to Sentry is on" : "Error reporting is off (no SENTRY_DSN)",
  );

  // One log line saying whether driver photo uploads can work. Not awaited:
  // it calls out to Cloudinary and must never hold up or crash startup.
  void checkCloudinaryAtStartup(config.cloudinary, app.log);

  // Periodically sweep REQUESTED/AWAITING_RIDER_DECISION rides for the 90s
  // dispatch and decision-grace timeouts (see services/ride/timeouts.ts).
  const timeoutSweep = setInterval(() => {
    processTimeouts(prisma, new Date(), { logger: app.log }).catch((err) => {
      app.log.error({ err }, "processTimeouts failed");
      noteDatabaseError(err, "timeout_sweep");
      alerts.timeoutSweepFailures.record({ error: err instanceof Error ? err.message : String(err) });
    });
  }, TIMEOUT_POLL_INTERVAL_MS);

  const receiptSweep = setInterval(() => {
    void checkPushReceipts(prisma);
  }, PUSH_RECEIPT_POLL_INTERVAL_MS);

  // A warning before the SMS balance runs out (login codes go by SMS).
  // Only when login codes really go through Moolre.
  const purgeClosedAccounts = () =>
    purgeDeletedAccounts(prisma).catch((err) => app.log.error({ err }, "Erasing closed accounts failed"));
  void purgeClosedAccounts();
  const accountPurge = setInterval(() => void purgeClosedAccounts(), ACCOUNT_PURGE_INTERVAL_MS);

  const timers = [timeoutSweep, receiptSweep, accountPurge];

  // App Store / Google Play review demo (docs/store/review-notes.md): off
  // unless REVIEW_DEMO_ENABLED=true and every setting is valid.
  const demo = reviewDemoConfig();
  for (const problem of demo.problems) app.log.warn({ event: "review_demo_off" }, `Review demo is off: ${problem}`);
  const demoLoop = await startReviewDemo(prisma).catch((err) => {
    app.log.error({ err }, "Review demo failed to start");
    return null;
  });
  if (demoLoop) {
    timers.push(demoLoop);
    app.log.warn({ event: "review_demo_on" }, "Review demo is ON: the two review numbers sign in with the fixed code (REVIEW_DEMO_ENABLED=false turns it off)");
  }
  if (otpService instanceof MoolreOtpService) {
    const checkBalance = createBalanceCheck({
      cfg: { baseUrl: config.moolre.baseUrl, apiUser: config.moolre.apiUser, vasKey: config.moolre.vasKey },
      lowBalance: config.moolre.smsLowBalance,
    });
    timers.push(
      setTimeout(() => void checkBalance(), SMS_BALANCE_FIRST_CHECK_MS),
      setInterval(() => void checkBalance(), SMS_BALANCE_INTERVAL_MS),
    );
  }

  // A deploy (SIGTERM from Render) or Ctrl-C finishes in-flight requests,
  // closes sockets and the database, then exits (lib/shutdown.ts). A fatal
  // error does the same, faster, and exits non-zero so Render restarts us.
  const shutdown = createShutdown({
    app,
    io,
    log: app.log,
    timers,
    disconnectDatabase: () => prisma.$disconnect(),
    flushReports: () => flushMonitoring(),
  });
  // For the life of the process, not once: a deploy's SIGTERM can arrive
  // twice (lib/shutdown.ts#installSignalHandlers).
  installSignalHandlers({ shutdown, log: app.log });
  onFatal((kind, err) => {
    app.log.fatal({ err, event: "fatal", kind }, `Fatal ${kind}: shutting down`);
    reportError(err, { level: "fatal", tags: { fatal: kind } });
    void shutdown(kind, 1);
  });
}

bootstrap().catch((err) => {
  // Last-resort handler: bootstrap has failed, so the Fastify logger may never
  // have been constructed. lib/logger needs nothing but stdout, and scrubs the
  // error (a database error can carry a connection string) on the way to exit(1).
  logger.error("Failed to start server", { err });
  reportError(err, { level: "fatal", tags: { phase: "startup" } });
  void flushMonitoring().finally(() => process.exit(1));
});
