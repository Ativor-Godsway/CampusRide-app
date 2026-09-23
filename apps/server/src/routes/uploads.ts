import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { buildDriverPhotoUploadTicket } from "../services/uploads/cloudinarySignature";

/**
 * Registers `POST /uploads/driver-photo/signature`.
 *
 * Hands an authenticated DRIVER a short-lived, single-purpose Cloudinary
 * upload ticket. The API secret stays here; the client receives only a
 * signature over parameters it cannot alter (folder, its OWN public id,
 * allowed formats, stored dimensions). Replaces the unsigned upload preset
 * that used to ship in the app bundle.
 */
export function registerUploadRoutes(app: FastifyInstance): void {
  app.post(
    "/uploads/driver-photo/signature",
    {
      preHandler: requireAuth,
      // Signing is cheap but each ticket authorizes a write into our
      // Cloudinary account, so this is not a route to leave on the global cap.
      config: { rateLimit: { max: config.rateLimit.uploadSignatureMax, timeWindow: "15 minutes" } },
    },
    async (request, reply) => {
      if (request.user?.role !== "DRIVER") {
        return reply.code(403).send({ error: "Driver role required" });
      }

      const { cloudName, apiKey, apiSecret } = config.cloudinary;
      if (!cloudName || !apiKey || !apiSecret) {
        // Fail explicitly rather than handing back a ticket signed with an
        // empty secret, which Cloudinary would reject with a confusing error.
        return reply.code(503).send({
          error: "Image uploads are not configured",
          code: "UPLOADS_NOT_CONFIGURED",
        });
      }

      const ticket = buildDriverPhotoUploadTicket(
        { cloudName, apiKey, apiSecret },
        request.user.userId,
      );

      return reply.code(200).send(ticket);
    },
  );
}
