/**
 * Stage 4, over the real route table and the server's real options
 * (http/serverOptions.ts): bad input gets a plain 400, nothing internal ever
 * reaches a client, every response carries a request id, and no log line
 * holds a full phone number, a login code or a token.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { prisma } from "../db/prisma";
import { registerAllRoutes } from "../routes";
import { DummyPaymentService } from "../services/payment/DummyPaymentService";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { signAccessToken } from "../services/auth/tokens";
import { uniqueGhanaPhone } from "../test/testPhone";
import { setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";
import { loggerOptions } from "../lib/loggerOptions";
import { BODY_LIMIT_BYTES, serverOptions } from "./serverOptions";
import { empty } from "./schemas";

let app: FastifyInstance;
const otp = new CapturingOtpService();
const logs: string[] = [];
const phones: string[] = [];
const userIds: string[] = [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
  const logger = {
    ...(loggerOptions as object),
    level: "info",
    stream: { write: (line: string) => void logs.push(line) },
  } as FastifyServerOptions["logger"];
  app = Fastify({ ...serverOptions(), logger });
  registerAllRoutes(app, prisma, { otpService: otp, paymentService: new DummyPaymentService() });

  // Stand-ins for a bug and a database failure inside a real handler.
  app.get("/__test/bug", { schema: { querystring: empty } }, async () => {
    throw new Error("Cannot read properties of undefined (reading 'driverId') for +233548617146");
  });
  app.get("/__test/db-error", { schema: { querystring: empty } }, async () =>
    prisma.$queryRawUnsafe('SELECT * FROM "no_such_table_stage4"'),
  );
  // A careless log line, of the kind a future change might add.
  app.post("/__test/careless-log", { schema: { body: empty } }, async (request) => {
    request.log.info(
      {
        phone: "0548617146",
        token: "abc",
        pushToken: "ExponentPushToken[xyz]",
        nested: { otpCode: "123456" },
      },
      "Sent code to +233548617146",
    );
    return { ok: true };
  });
  await app.ready();
});

beforeEach(() => {
  setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
});

afterAll(async () => {
  await prisma.otpCode.deleteMany({ where: { phone: { in: phones } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({
    where: { OR: [{ id: { in: userIds } }, { phone: { in: phones } }] },
  });
  await app.close();
});

async function newUser(role: "RIDER" | "ADMIN" = "RIDER") {
  const phone = uniqueGhanaPhone();
  phones.push(phone);
  const user = await prisma.user.create({ data: { phone, name: "Ama", role } });
  userIds.push(user.id);
  return { user, auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role })}` } };
}

describe("bad input gets a plain 400", () => {
  it("names the missing field", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/request-otp", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "phone is required",
      code: "INVALID_REQUEST",
      requestId: expect.stringMatching(UUID),
    });
  });

  it("refuses a field that is too long", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone: "0".repeat(41), purpose: "LOGIN" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("phone must be at most 40 characters");
  });

  it("refuses the wrong type instead of converting it", async () => {
    const { auth } = await newUser();
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth,
      payload: { name: 42 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("name must be a string");
  });

  it("refuses an id that isn't an id", async () => {
    const { auth } = await newUser();
    const res = await app.inject({ method: "GET", url: `/rides/${"x".repeat(65)}`, headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("id must be at most 64 characters");
    const odd = await app.inject({ method: "GET", url: "/rides/abc%20def", headers: auth });
    expect(odd.json().error).toBe("id isn't in a valid format");
  });

  it("drops fields a route doesn't take: a rider can't make themself an admin", async () => {
    const { user, auth } = await newUser();
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: auth,
      payload: { name: "Ama B", role: "ADMIN", isApproved: true },
    });
    expect(res.statusCode).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).role).toBe("RIDER");
  });

  it("checks who you are before what you sent", async () => {
    const anonymous = await app.inject({
      method: "POST",
      url: "/rides",
      payload: { junk: "x".repeat(5000) },
    });
    expect(anonymous.statusCode).toBe(401);
    const { auth } = await newUser();
    const rider = await app.inject({
      method: "GET",
      url: "/admin/rides?limit=not-a-number",
      headers: auth,
    });
    expect(rider.statusCode).toBe(403);
  });

  it("says when the JSON itself is broken", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      headers: { "content-type": "application/json" },
      payload: '{"phone": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: "INVALID_JSON",
      requestId: expect.stringMatching(UUID),
    });
  });

  it(`refuses a body over ${BODY_LIMIT_BYTES / 1024} KB`, async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone: "0548617146", purpose: "LOGIN", padding: "x".repeat(BODY_LIMIT_BYTES) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({
      error: "That request is too large.",
      code: "BODY_TOO_LARGE",
      requestId: expect.stringMatching(UUID),
    });
  });
});

describe("nothing internal reaches a client", () => {
  it("a bug is a generic 500 with a request id", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/bug" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Something went wrong on our side. Please try again.",
      code: "INTERNAL_ERROR",
      requestId: res.headers["x-request-id"],
    });
  });

  it("a database error shows no Prisma message, SQL or stack", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/db-error" });
    expect(res.statusCode).toBe(500);
    for (const leak of ["no_such_table", "42P01", "prisma", "Prisma", "SELECT", "    at "]) {
      expect(res.body).not.toContain(leak);
    }
    // …but the log has it, under the same request id, for whoever investigates.
    const line = logs.find(
      (l) => l.includes(String(res.headers["x-request-id"])) && l.includes("no_such_table_stage4"),
    );
    expect(line).toBeDefined();
  });

  it("an unknown route is a JSON 404", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: "Not found.",
      code: "NOT_FOUND",
      requestId: expect.stringMatching(UUID),
    });
  });

  it("every response has a fresh request id, never one the client chose", async () => {
    const a = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "chosen-by-client" },
    });
    const b = await app.inject({ method: "GET", url: "/health" });
    expect(a.headers["x-request-id"]).toMatch(UUID);
    expect(b.headers["x-request-id"]).toMatch(UUID);
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });
});

describe("no log line holds a phone number, code or token", () => {
  it("a whole sign-up and sign-in leaves none of them in the logs", async () => {
    const phone = uniqueGhanaPhone();
    phones.push(phone);
    const before = logs.length;
    await app.inject({
      method: "POST",
      url: "/auth/request-otp",
      payload: { phone, purpose: "SIGNUP" },
    });
    const code = otp.codeFor(phone);
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify-otp",
      payload: { phone, code, purpose: "SIGNUP" },
    });
    const { verifiedToken } = verify.json();
    const signup = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { phone, name: "Kojo", role: "RIDER", verifiedToken },
    });
    expect(signup.statusCode).toBe(201);
    const { accessToken, refreshToken, user } = signup.json();
    userIds.push(user.id);
    await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken } });
    await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    const written = logs.slice(before).join("\n");
    expect(written.length).toBeGreaterThan(0);
    expect(written).not.toContain(phone);
    expect(written).not.toContain(phone.slice(1)); // 233…
    expect(written).not.toContain(`0${phone.slice(4)}`); // 0…
    expect(written).not.toMatch(new RegExp(`(?<!\\d)${code}(?!\\d)`));
    for (const token of [verifiedToken, accessToken, refreshToken])
      expect(written).not.toContain(token);
  });

  it("a phone number or tracking token in a URL is masked in the request log", async () => {
    const { auth } = await newUser("ADMIN");
    const before = logs.length;
    await app.inject({ method: "GET", url: "/admin/rate-limits?phone=0548617146", headers: auth });
    await app.inject({ method: "GET", url: `/track/${"ab12".repeat(16)}` });
    const written = logs.slice(before).join("\n");
    expect(written).toContain("phone=+233*****146");
    expect(written).toContain("/track/[token]");
    expect(written).not.toContain("0548617146");
    expect(written).not.toContain("ab12ab12");
  });

  it("even a careless log line is scrubbed", async () => {
    const before = logs.length;
    await app.inject({ method: "POST", url: "/__test/careless-log", payload: {} });
    const line = logs.slice(before).find((l) => l.includes("Sent code"));
    expect(JSON.parse(line!)).toMatchObject({
      msg: "Sent code to +233*****146",
      phone: "+233*****146",
      token: "[redacted]",
      pushToken: "[redacted]",
      nested: { otpCode: "[redacted]" },
    });
  });

  it("an error's message and stack are scrubbed too", async () => {
    const before = logs.length;
    await app.inject({ method: "GET", url: "/__test/bug" });
    const written = logs.slice(before).join("\n");
    expect(written).toContain("+233*****146");
    expect(written).not.toContain("548617146");
  });
});
