import type { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";
import { config } from "../config";
import { buildDriverPhotoUploadTicket } from "../services/uploads/cloudinarySignature";
import { missingCloudinaryVars } from "../services/uploads/cloudinaryConfig";

/** Failure kinds the app may report from the Cloudinary leg of an upload. */
const REPORTABLE_FAILURE_KINDS = [
  "upload_failed",
  "too_large",
  "wrong_type",
  "signature_failed",
] as const;
type ReportableFailureKind = (typeof REPORTABLE_FAILURE_KINDS)[number];

/**
 * Makes a client-reported Cloudinary error safe to log: bounded length, and
 * no signatures. Cloudinary's "Invalid Signature" error echoes the 40-hex
 * SHA-1 signature it received, which does not belong in our logs.
 */
export function sanitizeUploadFailureMessage(message: unknown): string | null {
  if (typeof message !== "string" || message.trim() === "") return null;
  return message
    .replace(/[0-9a-f]{40}/gi, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 300);
}

/**
 * Registers the driver-photo upload routes:
 *
 * - `POST /uploads/driver-photo/signature` hands an authenticated DRIVER a
 *   short-lived, single-purpose Cloudinary upload ticket. The API secret stays
 *   here; the client receives only a signature over parameters it cannot alter
 *   (its OWN public id, allowed formats, stored dimensions).
 * - `POST /uploads/driver-photo/failure` lets the app report why Cloudinary
 *   refused an upload. The file goes phone → Cloudinary directly, so without
 *   this the real cause would only ever be visible on the phone.
 */
export function registerUploadRoutes(app: FastifyInstance): void {
  // Signing is cheap but each ticket authorizes a write into our Cloudinary
  // account, so neither route is left on the global cap.
  const rateLimit = { max: config.rateLimit.uploadSignatureMax, timeWindow: "15 minutes" };

  app.post(
    "/uploads/driver-photo/signature",
    { preHandler: requireAuth, config: { rateLimit } },
    async (request, reply) => {
      if (request.user?.role !== "DRIVER") {
        return reply
          .code(403)
          .send({ error: "Driver role required", code: "DRIVER_ROLE_REQUIRED" });
      }

      const missing = missingCloudinaryVars(config.cloudinary);
      if (missing.length > 0) {
        // Fail explicitly rather than handing back a ticket signed with an
        // empty secret, which Cloudinary would reject with a confusing error.
        request.log.error(
          { event: "driver_photo_signature_failed", reason: "cloudinary_not_configured", missing },
          `Driver photo upload refused: Cloudinary env vars missing: ${missing.join(", ")}`,
        );
        return reply.code(503).send({
          error: "Image uploads are not configured",
          code: "UPLOADS_NOT_CONFIGURED",
        });
      }

      const ticket = buildDriverPhotoUploadTicket(config.cloudinary, request.user.userId);
      request.log.info(
        { event: "driver_photo_signature_issued", userId: request.user.userId },
        "Driver photo upload ticket issued",
      );
      return reply.code(200).send(ticket);
    },
  );

  app.post(
    "/uploads/driver-photo/failure",
    { preHandler: requireAuth, config: { rateLimit } },
    async (request, reply) => {
      if (request.user?.role !== "DRIVER") {
        return reply
          .code(403)
          .send({ error: "Driver role required", code: "DRIVER_ROLE_REQUIRED" });
      }

      const body = (request.body ?? {}) as { kind?: unknown; status?: unknown; message?: unknown };
      if (!REPORTABLE_FAILURE_KINDS.includes(body.kind as ReportableFailureKind)) {
        return reply.code(400).send({ error: "kind is not a reportable failure" });
      }
      const status =
        typeof body.status === "number" && Number.isInteger(body.status) ? body.status : null;
      const cloudinaryMessage = sanitizeUploadFailureMessage(body.message);

      request.log.warn(
        {
          event: "driver_photo_upload_failed",
          userId: request.user.userId,
          kind: body.kind,
          status,
          cloudinaryMessage,
        },
        `Driver photo upload to Cloudinary failed (${String(body.kind)}${status ? `, HTTP ${status}` : ""}): ${cloudinaryMessage ?? "no message"}`,
      );
      return reply.code(204).send();
    },
  );
}
