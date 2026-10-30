/**
 * Admin passkeys. A fake authenticator (a P-256 key, as Face ID / Touch ID
 * use) makes real WebAuthn answers, checked by the same library as in
 * production. Pins:
 *   1. an admin adds a passkey to their own account, and signs in with it
 *      (an admin session; "Admin logins" says passkey);
 *   2. an answer for another site, a reused challenge, or an unknown passkey
 *      gets nothing (and the attempt is recorded);
 *   3. once an admin has a passkey, phone codes are refused for them —
 *      unless ADMIN_OTP_FALLBACK=on;
 *   4. a passkey of an account that is no longer an admin signs nobody in;
 *      an admin can only list and remove their own.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAllRoutes } from "./index";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { signAccessToken } from "../services/auth/tokens";
import { createTestUser } from "../services/ride/testFixtures";
import { resetPasskeyChallengesForTests } from "../services/auth/passkeys";
import { setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";

const ORIGIN = config.adminPasskeys.origins[0]!;
const RP_ID = config.adminPasskeys.rpId;
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

/** A passkey on a device: answers WebAuthn as Safari / Chrome would hand it to the site. */
class FakeAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = pair.privateKey;
    this.publicKey = pair.publicKey;
  }
  get id() {
    return b64url(this.credentialId);
  }
  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }
  register(options: { challenge: string }, origin = ORIGIN, rpId = RP_ID) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x45 | 0x08 | 0x10]), // user present + verified + attested; backup eligible + backed up
      Buffer.alloc(4),
      Buffer.alloc(16),
      idLength,
      this.credentialId,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
    };
  }
  signIn(options: { challenge: string }, origin = ORIGIN) {
    const clientDataJSON = this.clientData("webauthn.get", options.challenge, origin);
    const authData = Buffer.concat([sha256(RP_ID), Buffer.from([0x05 | 0x08 | 0x10]), Buffer.alloc(4)]);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.key);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
    };
  }
}

let app: FastifyInstance;
const otpService = new CapturingOtpService();
const userIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAllRoutes(app, prisma, { otpService, paymentService: new DummyPaymentService() });
  await app.ready();
});
beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
  resetPasskeyChallengesForTests();
});
afterEach(async () => {
  (config.adminPasskeys as { otpFallback: boolean }).otpFallback = false;
  const ids = userIds.splice(0);
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ actor: { in: ids } }, { target: { in: ids } }, { target: "passkey" }] } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function admin() {
  const created = await createTestUser("RIDER");
  const user = await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } });
  userIds.push(user.id);
  return { user, headers: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "ADMIN" })}`, "x-campusride-client": "admin" } };
}

const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
  app.inject({ method: "POST", url, headers: { "x-campusride-client": "admin", ...headers }, payload });

/** Adds a passkey to this admin's account through the routes, as the admin site does. */
async function addPasskey(headers: Record<string, string>, device = new FakeAuthenticator(), name = "MacBook") {
  const opts = (await post("/admin/passkeys/options", {}, headers)).json();
  expect(opts.options.rp.id).toBe(RP_ID);
  expect(opts.options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  const res = await post("/admin/passkeys", { challengeId: opts.challengeId, response: device.register(opts.options), name }, headers);
  expect(res.statusCode).toBe(201);
  return device;
}

async function passkeyLogin(device: FakeAuthenticator, origin = ORIGIN) {
  const opts = (await post("/auth/passkey/options", {})).json();
  return post("/auth/passkey/login", { challengeId: opts.challengeId, response: device.signIn(opts.options, origin) });
}

describe("adding a passkey and signing in with it", () => {
  it("an admin adds one, sees it listed, and signs in with Face ID / Touch ID", async () => {
    const a = await admin();
    const device = await addPasskey(a.headers);
    const list = await app.inject({ method: "GET", url: "/admin/passkeys", headers: a.headers });
    expect(list.json().passkeys).toEqual([expect.objectContaining({ name: "MacBook", backedUp: true, lastUsedAt: null })]);
    expect(JSON.stringify(list.json())).not.toContain(device.id);
    expect(await prisma.adminAuditLog.count({ where: { actor: a.user.id, action: "admin.passkey.add" } })).toBe(1);

    const res = await passkeyLogin(device);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user).toMatchObject({ id: a.user.id, role: "ADMIN" });
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(Date.parse(body.sessionExpiresAt) - Date.now()).toBeGreaterThan((config.adminSession.maxHours - 1) * 3600_000);
    // The session works on admin routes.
    const me = await app.inject({ method: "GET", url: "/admin/passkeys", headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().passkeys[0].lastUsedAt).not.toBeNull();
    expect(await prisma.adminAuditLog.findFirst({ where: { actor: a.user.id, action: "admin.login.success" } })).toMatchObject({ reason: "passkey" });
  });

  it("gets nothing for another site's answer, a reused challenge, or an unknown passkey", async () => {
    const a = await admin();
    const device = await addPasskey(a.headers);
    expect((await passkeyLogin(device, "https://campusride-admin.evil.example")).statusCode).toBe(401);

    const opts = (await post("/auth/passkey/options", {})).json();
    const answer = device.signIn(opts.options);
    expect((await post("/auth/passkey/login", { challengeId: opts.challengeId, response: answer })).statusCode).toBe(200);
    expect((await post("/auth/passkey/login", { challengeId: opts.challengeId, response: answer })).statusCode).toBe(401);

    const stranger = new FakeAuthenticator();
    const res = await passkeyLogin(stranger);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("PASSKEY_FAILED");
    expect(await prisma.adminAuditLog.count({ where: { action: "admin.login.failure", reason: "passkey_failed" } })).toBeGreaterThanOrEqual(2);
  });

  it("a passkey whose account is no longer an admin signs nobody in", async () => {
    const a = await admin();
    const device = await addPasskey(a.headers);
    await prisma.user.update({ where: { id: a.user.id }, data: { role: "RIDER" } });
    const res = await passkeyLogin(device);
    expect(res.statusCode).toBe(403);
    expect(res.json().accessToken).toBeUndefined();
  });
});

describe("phone codes for an admin with a passkey", () => {
  const sendCode = (phone: string) => post("/auth/request-otp", { phone, purpose: "LOGIN" });

  it("an admin without a passkey still gets a code", async () => {
    const a = await admin();
    expect((await sendCode(a.user.phone)).statusCode).toBe(200);
  });

  it("are refused once they have one, and recorded", async () => {
    const a = await admin();
    await addPasskey(a.headers);
    const res = await sendCode(a.user.phone);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "ADMIN_PASSKEY_REQUIRED" });
    expect(res.json().error).toMatch(/passkey/i);
    expect(await prisma.adminAuditLog.count({ where: { actor: a.user.id, reason: "passkey_required" } })).toBe(1);
  });

  it("work again while ADMIN_OTP_FALLBACK=on (recovery)", async () => {
    const a = await admin();
    await addPasskey(a.headers);
    (config.adminPasskeys as { otpFallback: boolean }).otpFallback = true;
    expect((await sendCode(a.user.phone)).statusCode).toBe(200);
    const verify = await post("/auth/verify-code", { phone: a.user.phone, code: otpService.codeFor(a.user.phone) });
    expect(verify.json()).toMatchObject({ status: "signedIn" });
  });
});

describe("an admin's own passkeys only", () => {
  it("another admin can't remove them; the owner can, and it's recorded", async () => {
    const [a, b] = [await admin(), await admin()];
    await addPasskey(a.headers);
    const [mine] = (await app.inject({ method: "GET", url: "/admin/passkeys", headers: a.headers })).json().passkeys;
    expect((await app.inject({ method: "GET", url: "/admin/passkeys", headers: b.headers })).json().passkeys).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/admin/passkeys/${mine.id}`, headers: b.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/admin/passkeys/${mine.id}`, headers: a.headers })).statusCode).toBe(200);
    expect(await prisma.adminPasskey.count({ where: { userId: a.user.id } })).toBe(0);
    expect(await prisma.adminAuditLog.count({ where: { actor: a.user.id, action: "admin.passkey.remove" } })).toBe(1);
  });
});
