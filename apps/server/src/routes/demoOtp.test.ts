/**
 * The demo site's per-IP cap counts the real client address, not one the
 * client wrote into X-Forwarded-For (which made the cap trivial to dodge).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { uniqueGhanaPhone } from "../test/testPhone";
import { registerDemoOtpRoutes } from "./demoOtp";

// Documentation-range addresses (RFC 5737): no other test uses them.
const CLIENT = "203.0.113.7";
const FORGED = ["198.51.100.1", "198.51.100.2"];

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  registerDemoOtpRoutes(app, prisma, new CapturingOtpService());
  await app.ready();
});

afterAll(async () => {
  await prisma.demoOtp.deleteMany({ where: { ip: { in: [CLIENT, ...FORGED] } } });
  await app.close();
});

describe("POST /demo/otp/send", () => {
  it("records the connecting address, whatever X-Forwarded-For claims", async () => {
    for (const forged of FORGED) {
      const res = await app.inject({
        method: "POST",
        url: "/demo/otp/send",
        remoteAddress: CLIENT,
        headers: { "x-forwarded-for": `${forged}, 10.0.0.1` },
        payload: { phone: uniqueGhanaPhone() },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await prisma.demoOtp.count({ where: { ip: CLIENT } })).toBe(FORGED.length);
    expect(await prisma.demoOtp.count({ where: { ip: { in: FORGED } } })).toBe(0);
  });
});
