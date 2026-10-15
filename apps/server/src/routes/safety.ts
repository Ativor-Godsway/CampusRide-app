import type { FastifyInstance, FastifyReply } from "fastify";
import { useRequestValidation } from "../http/validation";
import type { PrismaClient, Ride, Zone } from "@prisma/client";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { RideNotActiveError, TRACKING_TOKEN_PATTERN, raiseSos } from "../services/safety/sos";
import { rideStatusLabel } from "../services/safety/rideStatusLabels";
import { requestPlaceNames } from "./ridePins";
import { rateLimitMessage } from "@rida/shared";
import { limiter } from "../rateLimit/limiter";
import { bodyOptional, empty, idParams, object, text } from "../http/schemas";
import { RULES } from "../rateLimit/rules";

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
  useRequestValidation(app);
  app.post(
    "/rides/:id/sos",
    {
      onRequest: requireAuth,
      preValidation: bodyOptional,
      schema: { params: idParams, body: empty },
      // NEVER rate limited: an emergency is never answered with "try again
      // later". The texts are what cost money, so raiseSos skips re-texting
      // the same people for a repeat press within a couple of minutes.
      config: { limits: false },
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
      // Anyone who was on the ride may raise it — even a rider whose seat was
      // cancelled, in case they are still in the car: an ownership rule must
      // never be what blocks an emergency. Strangers get the same answer as
      // for a ride that doesn't exist.
      const onRide =
        ride && (ride.riderId === userId || ride.passengers.some((p) => p.riderId === userId));
      if (!ride || !onRide) return reply.code(404).send({ error: "Ride not found" });

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
   * minimal read-only view: status, the SOS rider's own stops (place names
   * only), driver and vehicle. It does NOT expose the driver's phone number,
   * the fare, exact coordinates, or anything about other riders in a shared
   * car — a link is about the one rider who raised the SOS (TrackingLink).
   *
   * Links expire TRACKING_LINK_TTL_HOURS after the ride ends (410 Gone);
   * while the ride is going on they always work.
   *
   * Served as a self-contained HTML page rather than JSON because the
   * recipient is a person opening an SMS link on their phone, and refreshes
   * itself so a contact can leave it open and watch the trip progress.
   */
  // The token is only length-checked here: a malformed one gets the
  // friendly "link not valid" page from the handler, not a JSON 400.
  app.get(
    "/track/:token",
    { schema: { params: object({ token: text(128, { nonEmpty: true }) }, ["token"]), querystring: empty } },
    async (request, reply) => {
    const { token } = request.params as { token: string };

    if (!TRACKING_TOKEN_PATTERN.test(token)) {
      return sendPage(reply, 404, page("Link not found", "<p>This tracking link is not valid.</p>"));
    }
    // Per link: a contact (or several) watching refreshes every 15 s; more
    // than that is something hammering the link.
    const allowed = await limiter.consume([{ rule: RULES.trackLink, subject: token }]);
    if (!allowed.ok) {
      const seconds = Math.max(1, Math.ceil(allowed.retryAfterMs / 1000));
      return sendPage(
        reply.header("retry-after", String(seconds)),
        429,
        page("Too many requests", `<p>${escapeHtml(rateLimitMessage(seconds))}</p>`),
      );
    }

    const link = await findTrackingLink(prisma, token);
    if (!link) {
      return sendPage(reply, 404, page("Link not found", "<p>This tracking link is not valid.</p>"));
    }

    const { ride } = link;
    const finished = ride.status === "COMPLETED" || ride.status === "CANCELLED";
    if (finished && isTrackingLinkExpired(link, config.trackingLinkTtlHours)) {
      return sendPage(
        reply,
        410,
        page("Link expired", "<p>This trip has ended and its tracking link has expired.</p>"),
      );
    }

    const [rider, seat, driver] = await Promise.all([
      prisma.user.findUnique({ where: { id: link.riderId }, select: { name: true, phone: true } }),
      prisma.ridePassenger.findFirst({
        where: { rideId: ride.id, riderId: link.riderId },
        include: { pickupZone: true, dropoffZone: true },
      }),
      ride.driverId
        ? prisma.user.findUnique({ where: { id: ride.driverId }, include: { driver: true } })
        : Promise.resolve(null),
    ]);

    const statusLabel = rideStatusLabel(ride.status);
    const vehicle = driver
      ? [driver.driver?.carColor, driver.driver?.carMake, driver.driver?.carModel]
          .filter(Boolean)
          .join(" ")
      : "";

    // This rider's own stops: their seat's (in a shared car they differ from
    // the booking's), or the ride's for a ride from before seats.
    const { pickupPlaceName, dropoffPlaceName } = seat
      ? requestPlaceNames(seat, seat.pickupZone.name, seat.dropoffZone.name)
      : requestPlaceNames(ride, ride.pickupZone.name, ride.dropoffZone.name);
    const rows = [
      ["Status", statusLabel],
      ["Rider", rider?.name ?? "—"],
      ["From", pickupPlaceName],
      ["To", dropoffPlaceName],
      ["Driver", driver?.name ?? "Not assigned yet"],
      ["Vehicle", vehicle || "—"],
      ["Plate", driver?.driver?.plate ?? "—"],
    ]
      .map(
        ([label, value]) =>
          `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(String(value))}</span></div>`,
      )
      .join("");

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
     * deliberately still withheld. (A deleted account's phone is a
     * placeholder, not a number, so it gets no button.)
     */
    const callable = rider?.phone.startsWith("+") ? rider.phone : null;
    const nudge = finished
      ? '<p class="sub">This trip has ended.</p>'
      : `<div class="nudge">
           <p class="nudgeTitle">${escapeHtml(rider?.name ?? "This rider")} asked you to keep an eye on this trip.</p>
           <p class="nudgeBody">If something looks wrong, call them now.</p>
           ${
             callable
               ? `<a class="cta" href="tel:${escapeHtml(callable.replace(/[\s()-]/g, ""))}">Call ${escapeHtml(rider!.name)}</a>`
               : ""
           }
         </div>
         <p class="sub">This page refreshes automatically.</p>`;

    return sendPage(
      reply,
      200,
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

type RideWithZones = Ride & { pickupZone: Zone; dropoffZone: Zone };

interface ResolvedTrackingLink {
  riderId: string;
  createdAt: Date;
  ride: RideWithZones;
}

/**
 * The link for a token: a TrackingLink row, or — for a link texted before
 * links were per rider — a ride's legacy trackingToken, which was always the
 * booking rider's. A legacy link has no creation time, so the ride's is used
 * (earlier, so it expires no later than it should).
 */
async function findTrackingLink(prisma: PrismaClient, token: string): Promise<ResolvedTrackingLink | null> {
  const link = await prisma.trackingLink.findUnique({
    where: { token },
    include: { ride: { include: { pickupZone: true, dropoffZone: true } } },
  });
  if (link) return { riderId: link.riderId, createdAt: link.createdAt, ride: link.ride };

  const legacy = await prisma.ride.findUnique({
    where: { trackingToken: token },
    include: { pickupZone: true, dropoffZone: true },
  });
  return legacy ? { riderId: legacy.riderId, createdAt: legacy.createdAt, ride: legacy } : null;
}

/**
 * Whether an ENDED ride's link has run out: TTL hours after the ride
 * completed, or — for a cancelled ride, which records no end time — after
 * the SOS itself (rides here last minutes, so that is about the same).
 */
export function isTrackingLinkExpired(
  link: { createdAt: Date; ride: { completedAt: Date | null } },
  ttlHours: number,
  now: Date = new Date(),
): boolean {
  const endedAt = Math.max(link.createdAt.getTime(), link.ride.completedAt?.getTime() ?? 0);
  return now.getTime() > endedAt + ttlHours * 60 * 60 * 1000;
}

/**
 * Every tracking response, found or not: never cached (it is the ride right
 * now), never indexed, never sent on as a referrer, never framed, and allowed
 * nothing but its own inline styles — no script, no remote content.
 */
function sendPage(reply: FastifyReply, status: number, html: string) {
  return reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("x-robots-tag", "noindex, nofollow")
    .header("referrer-policy", "no-referrer")
    .header(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    )
    .send(html);
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
