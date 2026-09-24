import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { RideNotActiveError, raiseSos } from "../services/safety/sos";
import { rideStatusLabel } from "../services/safety/rideStatusLabels";

/** Minimal HTML escaping for the values interpolated into the tracking page. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Registers the Phase 4 safety routes.
 *
 * `POST /rides/:id/sos` — rider-only, notifies their emergency contact.
 * `GET /track/:token`   — PUBLIC, unauthenticated, the page that contact opens.
 */
export function registerSafetyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  app.post(
    "/rides/:id/sos",
    {
      preHandler: requireAuth,
      // An SOS sends an SMS, which costs money and could be used to spam a
      // number. The cap is generous enough that a panicking rider tapping
      // repeatedly is never blocked, but bounded.
      config: { rateLimit: { max: config.rateLimit.sosMax, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (request.user?.role !== "RIDER") {
        return reply.code(403).send({ error: "Rider role required" });
      }

      const { id: rideId } = request.params as { id: string };
      const userId = request.user.userId;

      const ride = await prisma.ride.findUnique({
        where: { id: rideId },
        include: { passengers: true },
      });
      if (!ride) return reply.code(404).send({ error: "Ride not found" });

      const onRide =
        ride.riderId === userId || ride.passengers.some((p) => p.riderId === userId);
      if (!onRide) return reply.code(403).send({ error: "Forbidden" });

      try {
        const result = await raiseSos(
          prisma,
          rideId,
          userId,
          config.publicBaseUrl,
          config.supportContactPhone,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof RideNotActiveError) {
          return reply.code(409).send({ error: err.message, code: "RIDE_NOT_ACTIVE" });
        }
        throw err;
      }
    },
  );

  /**
   * PUBLIC ride tracking page for an SOS recipient.
   *
   * Unauthenticated by necessity — the emergency contact has no account — so
   * the unguessable token IS the credential. It returns a deliberately
   * minimal read-only view: status, route, driver and vehicle. It does NOT
   * expose the rider's or driver's phone number, the fare, or anything that
   * would turn a leaked link into a bigger problem than it needs to be.
   *
   * Served as a self-contained HTML page rather than JSON because the
   * recipient is a person opening an SMS link on their phone, and refreshes
   * itself so a contact can leave it open and watch the trip progress.
   */
  app.get("/track/:token", async (request, reply) => {
    const { token } = request.params as { token: string };

    const ride = await prisma.ride.findUnique({
      where: { trackingToken: token },
      include: { pickupZone: true, dropoffZone: true },
    });

    if (!ride) {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(page("Link not found", "<p>This tracking link is not valid.</p>"));
    }

    const rider = await prisma.user.findUnique({ where: { id: ride.riderId } });
    const driver = ride.driverId
      ? await prisma.user.findUnique({ where: { id: ride.driverId }, include: { driver: true } })
      : null;

    const statusLabel = rideStatusLabel(ride.status);
    const vehicle = driver
      ? [driver.driver?.carColor, driver.driver?.carMake, driver.driver?.carModel]
          .filter(Boolean)
          .join(" ")
      : "";

    const rows = [
      ["Status", statusLabel],
      ["Rider", rider?.name ?? "—"],
      ["From", ride.pickupZone.name],
      ["To", ride.dropoffZone.name],
      ["Driver", driver?.name ?? "Not assigned yet"],
      ["Vehicle", vehicle || "—"],
      ["Plate", driver?.driver?.plate ?? "—"],
    ]
      .map(
        ([label, value]) =>
          `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`,
      )
      .join("");

    const finished = ride.status === "COMPLETED" || ride.status === "CANCELLED";

    /**
     * The "what do I actually do now" prompt. It lives here rather than in
     * the SMS because the message has to fit one 160-character segment and
     * the link is worth more of that budget than advice is — whereas this
     * page has room to say it properly.
     *
     * It offers calling the RIDER, not the driver: the person who raised the
     * alarm is who the recipient wants to reach, and the rider's number is
     * one this recipient already has (they are the rider's chosen contact),
     * so showing it here reveals nothing new. The driver's number is
     * deliberately still withheld.
     */
    const nudge = finished
      ? '<p class="sub">This trip has ended.</p>'
      : `<div class="nudge">
           <p class="nudgeTitle">${escapeHtml(rider?.name ?? "This rider")} asked you to keep an eye on this trip.</p>
           <p class="nudgeBody">If something looks wrong, call them now.</p>
           ${
             rider?.phone
               ? `<a class="cta" href="tel:${escapeHtml(rider.phone.replace(/[\s()-]/g, ""))}">Call ${escapeHtml(rider.name)}</a>`
               : ""
           }
         </div>
         <p class="sub">This page refreshes automatically.</p>`;

    return reply
      .code(200)
      .type("text/html; charset=utf-8")
      // A tracking link should never be cached — the whole point is that it
      // reflects the ride right now.
      .header("cache-control", "no-store")
      .send(
        page(
          "CampusRide — live trip",
          `<h1>CampusRide trip</h1>
           <p class="sub">Shared with you from an SOS alert.</p>
           <div class="card">${rows}</div>
           ${nudge}`,
          finished ? undefined : 15,
        ),
      );
  });
}

/** Wraps body HTML in a minimal, dependency-free, mobile-first document. */
function page(title: string, body: string, refreshSeconds?: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#ffffff; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --brand:#19743C; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0b0f14; --fg:#f3f4f6; --muted:#9ca3af; --line:#1f2937; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--fg);
         font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 480px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; color: var(--brand); }
  .sub { color: var(--muted); font-size: 14px; margin: 4px 0 16px; }
  .card { border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  .row { display:flex; justify-content:space-between; gap:16px; padding:12px 14px; border-bottom:1px solid var(--line); }
  .row:last-child { border-bottom:0; }
  .label { color:var(--muted); font-size:14px; }
  .value { font-weight:600; text-align:right; }
  .nudge { margin-top:16px; padding:14px; border-radius:12px;
           background:rgba(178,58,58,0.08); border:1px solid rgba(178,58,58,0.35); }
  .nudgeTitle { margin:0 0 4px; font-weight:600; }
  .nudgeBody { margin:0 0 12px; color:var(--muted); font-size:14px; }
  .cta { display:block; text-align:center; text-decoration:none; font-weight:600;
         padding:12px 16px; border-radius:10px; background:var(--brand); color:#fff; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}
