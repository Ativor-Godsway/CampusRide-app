import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as SocketServer } from "socket.io";
import { APP_NAME, config } from "./config";
import { prisma } from "./db/prisma";
import { processTimeouts } from "./services/ride/timeouts";
import { otpService, paymentService, routeService } from "./services/active";
import { registerAuthRoutes } from "./routes/auth";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerZoneRoutes } from "./routes/zones";
import { registerRideRoutes } from "./routes/rides";
import { registerRatingRoutes } from "./routes/ratings";
import { registerDriverRoutes } from "./routes/driver";
import { registerUssdRoutes } from "./routes/ussd";
import { initRideSocket } from "./realtime/rideSocket";

// 15s was too aggressive for Neon's pooled connection budget alongside
// request traffic; 30s still keeps the 90s dispatch/decision timeouts
// responsive (worst case +30s) while halving the steady-state query load.
const TIMEOUT_POLL_INTERVAL_MS = 30_000;

export { paymentService, routeService, otpService };

async function bootstrap() {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
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
  registerWebhookRoutes(app, prisma, paymentService, config.moolre.webhookSecret);
  registerZoneRoutes(app, prisma);
  registerRideRoutes(app, prisma);
  registerRatingRoutes(app, prisma);
  registerDriverRoutes(app, prisma);
  registerUssdRoutes(app, prisma);

  // app.server is the underlying http.Server — attach Socket.io to it directly
  await app.ready();

  const io = new SocketServer(app.server, {
    cors: { origin: "*" },
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
  console.error("Failed to start server:", err);
  process.exit(1);
});
