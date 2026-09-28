import { describe, it, expect, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAuthRoutes } from "./auth";
import { registerDriverRoutes } from "./driver";
import { registerUploadRoutes, sanitizeUploadFailureMessage } from "./uploads";
import { signAccessToken } from "../services/auth/tokens";
import { driverPhotoPublicId } from "../services/uploads/cloudinarySignature";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { cleanupDriver, createTestUser } from "../services/ride/testFixtures";

/**
 * End-to-end (via Fastify injection) coverage of the driver-photo chain the
 * app walks through during onboarding: get a signed ticket, then save the
 * resulting Cloudinary URL on the profile.
 *
 * config.cloudinary is set explicitly per test. Left alone it would come from
 * whatever .env the machine happens to have, which made photo tests pass on
 * one laptop and fail on another.
 */
type MutableCloudinary = { cloudName: string; apiKey: string; apiSecret: string };
const cloudinary = config.cloudinary as MutableCloudinary;
const original = { ...cloudinary };
const TEST_CLOUDINARY = {
  cloudName: "campusride-test",
  apiKey: "111222333444555",
  apiSecret: "test-secret",
};

let app: FastifyInstance;
const createdUserIds: string[] = [];

beforeAll(async () => {
  app = Fastify();
  registerAuthRoutes(app, prisma, new CapturingOtpService());
  registerDriverRoutes(app, prisma);
  registerUploadRoutes(app);
  await app.ready();
});

beforeEach(() => {
  Object.assign(cloudinary, TEST_CLOUDINARY);
});

afterEach(async () => {
  Object.assign(cloudinary, original);
  while (createdUserIds.length > 0) {
    await cleanupDriver(createdUserIds.pop()!);
  }
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** A freshly signed-up driver: Driver row exists, every profile field empty. */
async function newDriver() {
  const user = await createTestUser("DRIVER");
  await prisma.driver.create({ data: { userId: user.id } });
  createdUserIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "DRIVER" }) };
}

async function newRider() {
  const user = await createTestUser("RIDER");
  createdUserIds.push(user.id);
  return { user, token: signAccessToken({ userId: user.id, role: "RIDER" }) };
}

function photoUrlFor(userId: string, cloudName = TEST_CLOUDINARY.cloudName): string {
  return `https://res.cloudinary.com/${cloudName}/image/upload/v1712345678/${driverPhotoPublicId(userId)}.jpg`;
}

const CAR = { carMake: "Toyota", carModel: "Vitz", carColor: "Silver", plate: "gr-4321-26" };

describe("POST /uploads/driver-photo/signature", () => {
  it("requires a login", async () => {
    const res = await app.inject({ method: "POST", url: "/uploads/driver-photo/signature" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses riders", async () => {
    const { token } = await newRider();
    const res = await app.inject({
      method: "POST",
      url: "/uploads/driver-photo/signature",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("DRIVER_ROLE_REQUIRED");
  });

  it("returns a ticket whose signature Cloudinary will accept, without the secret", async () => {
    const { user, token } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/uploads/driver-photo/signature",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const ticket = JSON.parse(res.body);

    expect(ticket.cloudName).toBe(TEST_CLOUDINARY.cloudName);
    expect(ticket.apiKey).toBe(TEST_CLOUDINARY.apiKey);
    expect(ticket.uploadUrl).toBe(
      `https://api.cloudinary.com/v1_1/${TEST_CLOUDINARY.cloudName}/image/upload`,
    );
    expect(ticket.params.public_id).toBe(driverPhotoPublicId(user.id));

    // Recompute exactly as Cloudinary does from the params the app will POST
    // back as strings: sorted k=v joined by &, secret appended, SHA-1.
    const toSign = Object.keys(ticket.params)
      .sort()
      .map((k) => `${k}=${String(ticket.params[k])}`)
      .join("&");
    const expected = createHash("sha1")
      .update(toSign + TEST_CLOUDINARY.apiSecret)
      .digest("hex");
    expect(ticket.signature).toBe(expected);

    expect(res.body).not.toContain(TEST_CLOUDINARY.apiSecret);
  });

  it.each([
    ["CLOUDINARY_CLOUD_NAME", { cloudName: "" }],
    ["CLOUDINARY_API_KEY", { apiKey: "" }],
    ["CLOUDINARY_API_SECRET", { apiSecret: "" }],
  ])("answers 503 UPLOADS_NOT_CONFIGURED when %s is missing", async (_name, override) => {
    Object.assign(cloudinary, override);
    const { token } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/uploads/driver-photo/signature",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).code).toBe("UPLOADS_NOT_CONFIGURED");
  });
});

describe("POST /uploads/driver-photo/failure", () => {
  it("accepts a report of a known failure kind", async () => {
    const { token } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/uploads/driver-photo/failure",
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "upload_failed", status: 401, message: "Invalid Signature" },
    });
    expect(res.statusCode).toBe(204);
  });

  it("rejects an unknown kind", async () => {
    const { token } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/uploads/driver-photo/failure",
      headers: { authorization: `Bearer ${token}` },
      payload: { kind: "anything-goes" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("strips signatures and bounds the length of what gets logged", () => {
    const sig = "a".repeat(40);
    const cleaned = sanitizeUploadFailureMessage(
      `Invalid Signature ${sig}. String to sign - 'timestamp=1'\n${"x".repeat(500)}`,
    );
    expect(cleaned).not.toContain(sig);
    expect(cleaned).toContain("[redacted]");
    expect(cleaned).not.toContain("\n");
    expect(cleaned!.length).toBeLessThanOrEqual(300);
  });
});

describe("POST /driver/profile (onboarding) with a photo", () => {
  it("saves the car details and this driver's own Cloudinary photo URL", async () => {
    const { user, token } = await newDriver();
    const photoUrl = photoUrlFor(user.id);

    const res = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...CAR, photoUrl },
    });
    expect(res.statusCode).toBe(200);

    const row = await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.photoUrl).toBe(photoUrl);
    expect(row.plate).toBe("GR-4321-26");

    // What the app reads back to decide it can leave onboarding.
    const me = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(JSON.parse(me.body).user.driver.photoUrl).toBe(photoUrl);
  });

  it("refuses a photo URL that is not an upload through this app", async () => {
    const { user, token } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...CAR, photoUrl: "https://example.com/someone-else.jpg" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("INVALID_PHOTO_URL");

    const row = await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.carMake).toBeNull();
  });

  it("refuses another driver's photo", async () => {
    const { token } = await newDriver();
    const { user: other } = await newDriver();
    const res = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...CAR, photoUrl: photoUrlFor(other.id) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("answers 404 DRIVER_NOT_FOUND rather than a 500 when the driver row is gone", async () => {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const token = signAccessToken({ userId: user.id, role: "DRIVER" });

    const res = await app.inject({
      method: "POST",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: CAR,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).code).toBe("DRIVER_NOT_FOUND");
  });
});

describe("PATCH /driver/profile (Account screen) photo change", () => {
  it("replaces the photo URL", async () => {
    const { user, token } = await newDriver();
    const photoUrl = photoUrlFor(user.id);

    const res = await app.inject({
      method: "PATCH",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { photoUrl },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).profile.photoUrl).toBe(photoUrl);
  });

  it("refuses a URL from a different Cloudinary account", async () => {
    const { user, token } = await newDriver();
    const res = await app.inject({
      method: "PATCH",
      url: "/driver/profile",
      headers: { authorization: `Bearer ${token}` },
      payload: { photoUrl: photoUrlFor(user.id, "someone-elses-cloud") },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("INVALID_PHOTO_URL");
  });
});
