import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { useRequestValidation } from "../http/validation";
import { adminOnly, requireAdmin, requireAuth } from "../middleware/auth";
import { empty, idParams, integer, noInput, object, oneOf, text } from "../http/schemas";
import { recordAdminLogin } from "../services/admin/loginAudit";
import { loginVerifiedAdmin } from "../services/auth/authService";
import { AdminNotAllowedError, NotAnAdminError, UserNotFoundError } from "../services/auth/errors";
import {
  PasskeyError,
  addPasskey,
  listPasskeys,
  loginOptions,
  registrationOptions,
  removePasskey,
  verifyPasskeyLogin,
} from "../services/auth/passkeys";

/**
 * Admin passkeys (services/auth/passkeys.ts).
 *
 * Signing in (public, like the code routes; the IP backstop applies):
 * - POST /auth/passkey/options — a challenge for the browser.
 * - POST /auth/passkey/login   — the browser's signed answer: an admin session,
 *   exactly as a code login gives, recorded in "Admin logins".
 *
 * An admin's own passkeys (signed in, admin only):
 * - GET    /admin/passkeys          — the list (names and dates, no key material).
 * - POST   /admin/passkeys/options  — a challenge to add one.
 * - POST   /admin/passkeys          — the browser's answer: the new passkey. Audit-logged.
 * - DELETE /admin/passkeys/:id      — removes one of their own. Audit-logged.
 */

/**
 * The browser's answers (WebAuthn JSON, base64url fields), field by field
 * with generous limits; the WebAuthn library then checks their contents.
 * Anything else the browser adds is dropped.
 */
const b64 = (max: number) => text(max, { nonEmpty: true });
const credentialFields = {
  id: b64(512),
  rawId: b64(512),
  type: oneOf(["public-key"]),
  authenticatorAttachment: oneOf(["platform", "cross-platform"]),
  clientExtensionResults: object({ credProps: object({ rk: { type: "boolean" } }) }),
};
const signInAnswer = object(
  {
    ...credentialFields,
    response: object(
      {
        clientDataJSON: b64(4096),
        authenticatorData: b64(4096),
        signature: b64(1024),
        userHandle: text(1024),
      },
      ["clientDataJSON", "authenticatorData", "signature"],
    ),
  },
  ["id", "rawId", "type", "response"],
);
const registrationAnswer = object(
  {
    ...credentialFields,
    response: object(
      {
        clientDataJSON: b64(4096),
        attestationObject: b64(16_384),
        authenticatorData: text(16_384),
        publicKey: text(4096),
        publicKeyAlgorithm: integer(-65_535, 65_535),
        transports: { type: "array", maxItems: 10, items: text(30) },
      },
      ["clientDataJSON", "attestationObject"],
    ),
  },
  ["id", "rawId", "type", "response"],
);

const SCHEMAS = {
  loginOptions: { body: empty },
  login: { body: object({ challengeId: text(64, { nonEmpty: true }), response: signInAnswer }, ["challengeId", "response"]) },
  list: noInput,
  addOptions: { body: empty },
  add: {
    body: object(
      { challengeId: text(64, { nonEmpty: true }), response: registrationAnswer, name: text(60) },
      ["challengeId", "response"],
    ),
  },
  remove: { params: idParams, querystring: empty },
};

export function registerAdminPasskeyRoutes(app: FastifyInstance, prisma: PrismaClient): void {
  useRequestValidation(app);
  const admin = { onRequest: [requireAuth, adminOnly] };

  app.post("/auth/passkey/options", { schema: SCHEMAS.loginOptions }, async (_request, reply) => {
    return reply.send(await loginOptions());
  });

  app.post("/auth/passkey/login", { schema: SCHEMAS.login }, async (request, reply) => {
    const body = request.body as { challengeId: string; response: AuthenticationResponseJSON };
    let userId: string;
    try {
      ({ userId } = await verifyPasskeyLogin(prisma, body));
    } catch (err) {
      if (!(err instanceof PasskeyError)) throw err;
      // No account is known yet: recorded against the attempt only.
      await recordAdminLogin(prisma, request, { outcome: "failure", phone: "", userId: null, reason: "passkey_failed" });
      return reply.code(401).send({ error: err.message, code: "PASSKEY_FAILED" });
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { phone: true } });
    const record = (outcome: "failure" | "success", reason: Parameters<typeof recordAdminLogin>[2]["reason"]) =>
      recordAdminLogin(prisma, request, { outcome, phone: user?.phone ?? "", userId, reason });
    try {
      const result = await loginVerifiedAdmin(prisma, userId);
      await record("success", "passkey");
      request.log.info({ event: "admin_login_passkey", userId }, "Admin signed in with a passkey");
      return reply.send(result);
    } catch (err) {
      if (err instanceof AdminNotAllowedError) {
        await record("failure", "not_allowlisted");
        return reply.code(403).send({ error: err.message, code: "ADMIN_NOT_ALLOWED" });
      }
      if (err instanceof NotAnAdminError || err instanceof UserNotFoundError) {
        await record("failure", "not_admin");
        return reply.code(403).send({ error: "This account is not an administrator.", code: "NOT_AN_ADMIN" });
      }
      throw err;
    }
  });

  app.get("/admin/passkeys", { ...admin, schema: SCHEMAS.list }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send({ passkeys: await listPasskeys(prisma, request.user!.userId) });
  });

  app.post("/admin/passkeys/options", { ...admin, schema: SCHEMAS.addOptions }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    return reply.send(await registrationOptions(prisma, request.user!.userId));
  });

  app.post("/admin/passkeys", { ...admin, schema: SCHEMAS.add }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as { challengeId: string; response: RegistrationResponseJSON; name?: string };
    try {
      const passkey = await addPasskey(prisma, request.user!.userId, { ...body, name: body.name ?? "" });
      return reply.code(201).send({ passkey });
    } catch (err) {
      if (err instanceof PasskeyError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete("/admin/passkeys/:id", { ...admin, schema: SCHEMAS.remove }, async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { id } = request.params as { id: string };
    if (!(await removePasskey(prisma, request.user!.userId, id))) {
      return reply.code(404).send({ error: "Passkey not found" });
    }
    return reply.send({ removed: true });
  });
}
