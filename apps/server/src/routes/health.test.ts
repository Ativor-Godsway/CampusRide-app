import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { prisma } from "../db/prisma";
import { alerts } from "../lib/alerts";
import { isWorkingStagingServer, registerHealthRoutes } from "./health";

async function appWith(db: Parameters<typeof registerHealthRoutes>[1], timeoutMs?: number) {
  const app = Fastify();
  registerHealthRoutes(app, db, timeoutMs);
  await app.ready();
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  alerts.databaseConnection.reset();
});

describe("GET /health", () => {
  it("answers without touching the database", async () => {
    const queryRaw = vi.fn();
    const app = await appWith({ $queryRaw: queryRaw } as never);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", app: expect.any(String) });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

/** A staging server's settings that pass every staging check (no real URL or code). */
const STAGING_ENV = {
  CAMPUSRIDE_ENV: "staging",
  DATABASE_URL: "postgresql://u:p@ep-divine-unit-ba9dcaud-pooler.example.neon.tech/db",
  DIRECT_URL: "postgresql://u:p@ep-divine-unit-ba9dcaud.example.neon.tech/db",
  STAGING_TEST_OTP: "123456",
};

describe("GET /health on staging", () => {
  it("says staging: true on a staging server that passes its checks", async () => {
    for (const [k, v] of Object.entries(STAGING_ENV)) vi.stubEnv(k, v);
    const app = await appWith({ $queryRaw: vi.fn() } as never);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toEqual({ status: "ok", app: expect.any(String), staging: true });
  });

  it("never says it without CAMPUSRIDE_ENV=staging, or when a staging check fails", () => {
    expect(isWorkingStagingServer({ ...STAGING_ENV, CAMPUSRIDE_ENV: undefined })).toBe(false);
    expect(isWorkingStagingServer({ ...STAGING_ENV, CAMPUSRIDE_ENV: "production" })).toBe(false);
    expect(isWorkingStagingServer({ ...STAGING_ENV, DATABASE_URL: "postgresql://u:p@ep-empty-violet-bay5yr3y.example.neon.tech/db" })).toBe(false);
    expect(isWorkingStagingServer({ ...STAGING_ENV, STAGING_TEST_OTP: undefined })).toBe(false);
    expect(isWorkingStagingServer(STAGING_ENV)).toBe(true);
  });
});

describe("GET /health/ready", () => {
  it("is 200 when the database answers", async () => {
    const app = await appWith(prisma);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("is 503 when the database refuses, with no details", async () => {
    const record = vi.spyOn(alerts.databaseConnection, "record");
    const failing = {
      $queryRaw: () =>
        Promise.reject(
          Object.assign(
            new Error("Can't reach database server at `ep-secret-host.neon.tech:5432`"),
            {
              name: "PrismaClientInitializationError",
            },
          ),
        ),
    };
    const app = await appWith(failing as never);
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "unavailable", database: "unreachable" });
    expect(res.body).not.toContain("neon");
    expect(record).toHaveBeenCalledWith({ where: "health_ready" });
  });

  it("is 503 when the database doesn't answer in time", async () => {
    const hanging = { $queryRaw: () => new Promise(() => {}) };
    const app = await appWith(hanging as never, 50);
    const started = Date.now();
    const res = await app.inject({ method: "GET", url: "/health/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ database: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
