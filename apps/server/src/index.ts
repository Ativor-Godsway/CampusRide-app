import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { Server as SocketServer } from "socket.io";
import { APP_NAME, config } from "./config";
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
import { registerAuthRoutes } from "./routes/auth";
import { registerDemoOtpRoutes } from "./routes/demoOtp";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerZoneRoutes } from "./routes/zones";
import { registerRideRoutes } from "./routes/rides";
import { registerRatingRoutes } from "./routes/ratings";
import { registerDriverRoutes } from "./routes/driver";
import { registerAdminRoutes } from "./routes/admin";
import { registerUssdRoutes } from "./routes/ussd";
import { registerUploadRoutes } from "./routes/uploads";
import { registerSafetyRoutes } from "./routes/safety";
import { initRideSocket } from "./realtime/rideSocket";

// 15s was too aggressive for Neon's pooled connection budget alongside
// request traffic; 30s still keeps the 90s dispatch/decision timeouts
// responsive (worst case +30s) while halving the steady-state query load.
const TIMEOUT_POLL_INTERVAL_MS = 30_000;

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

  // trustProxy: Render terminates TLS at a proxy, so the socket IP is the
  // proxy's. Trusting it makes request.ip (and therefore the rate limiter's
  // per-IP keys) resolve to the real client via X-Forwarded-For, rather than
  // rate-limiting every user under one shared proxy IP.
  //
  // This is a HOP COUNT, not `true`. `true` trusts the entire forwarded
  // chain, so any client could send its own X-Forwarded-For and pick a fresh
  // "IP" per request, silently defeating every per-IP limit in
  // config.rateLimit. See lib/security.ts#resolveTrustProxy.
  const trustProxy = resolveTrustProxy(config.trustProxy, config.nodeEnv);
  const app = Fastify({ logger: true, trustProxy: toFastifyTrustProxy(trustProxy) });

  // Global rate limiter. Routes without an explicit `config.rateLimit`
  // override fall back to globalMax per minute per IP. Per-route overrides
  // (auth/ride/payment/ussd) are set on each route's options. Keyed on
  // request.ip (real client IP thanks to trustProxy above). Sensitive OTP/
  // payment routes tighten this further; none of it removes the existing
  // per-phone OTP caps in services/auth/otp.ts — the two layers stack.
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: "1 minute",
  });

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

  app.get("/health", async () => {
    return { status: "ok", app: APP_NAME };
  });

  registerAuthRoutes(app, prisma, otpService);
  registerDemoOtpRoutes(app, prisma, otpService);
  registerWebhookRoutes(app, prisma, paymentService, config.moolre.webhookSecret);
  registerZoneRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  registerRatingRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerAdminRoutes(app, prisma);
  registerUssdRoutes(app, prisma);
  registerUploadRoutes(app);
  registerSafetyRoutes(app, prisma);

  // app.server is the underlying http.Server — attach Socket.io to it directly
  await app.ready();

  // Socket.io gets the SAME origin policy as HTTP. It used to be an
  // unconditional "*", which meant any web page could open an authenticated
  // ride socket in a visitor's browser regardless of the HTTP CORS rules.
  const io = new SocketServer(app.server, {
    cors: { origin: corsOrigin },
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

  // Periodically sweep REQUESTED/AWAITING_RIDER_DECISION rides for the 90s
  // dispatch and decision-grace timeouts (see services/ride/timeouts.ts).
  setInterval(() => {
    processTimeouts(prisma, new Date(), { logger: app.log }).catch((err) => {
      app.log.error({ err }, "processTimeouts failed");
    });
  }, TIMEOUT_POLL_INTERVAL_MS);
}

bootstrap().catch((err) => {
  // Last-resort handler: bootstrap has failed, so the Fastify logger may never
  // have been constructed. console is the only output guaranteed to exist on
  // the way to exit(1).
  // eslint-disable-next-line no-console
  console.error("Failed to start server:", err);
  process.exit(1);
});
