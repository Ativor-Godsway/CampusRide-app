/**
 * End-to-end CORS behaviour: the real env-var string, through the real
 * parse/resolve helpers, into a real @fastify/cors registration.
 *
 * security.test.ts unit-tests the helpers in isolation. This file exists
 * because the helpers were already correct when the admin site broke — the
 * bug lived in the gap between "the allowlist looks right" and "the browser
 * actually gets an Access-Control-Allow-Origin header back".
 *
 * NOTE ON WHAT "BLOCKED" MEANS: @fastify/cors does not reject a disallowed
 * request. It returns the response as normal and simply OMITS the
 * Access-Control-Allow-Origin header; the browser is what discards it. So
 * every assertion here is on that header, not on the status code — asserting
 * a 403 would pass for the wrong reason and hide a real regression.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { parseOriginAllowlist, resolveCorsOrigin } from "./security";

const ADMIN_ORIGIN = "https://campusride-admin.onrender.com";

/**
 * Builds a server exactly the way index.ts does: raw CORS_ALLOWED_ORIGINS
 * string in, resolved policy out.
 */
async function serverWith(rawEnvValue: string, nodeEnv: string) {
  const allowlist = parseOriginAllowlist(rawEnvValue);
  const app = Fastify();
  await app.register(cors, { origin: resolveCorsOrigin(allowlist, nodeEnv) });
  app.get("/health", async () => ({ status: "ok" }));
  await app.ready();
  return app;
}

/** The Access-Control-Allow-Origin the browser would see, or null if blocked. */
async function allowOriginFor(app: Awaited<ReturnType<typeof serverWith>>, origin?: string) {
  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: origin ? { origin } : {},
  });
  expect(res.statusCode).toBe(200);
  return (res.headers["access-control-allow-origin"] as string | undefined) ?? null;
}

describe("CORS policy in production", () => {
  it("grants an origin that is on the list", async () => {
    const app = await serverWith(ADMIN_ORIGIN, "production");
    expect(await allowOriginFor(app, ADMIN_ORIGIN)).toBe(ADMIN_ORIGIN);
    await app.close();
  });

  it("blocks an origin that is not on the list", async () => {
    const app = await serverWith(ADMIN_ORIGIN, "production");
    expect(await allowOriginFor(app, "https://not-our-admin.example")).toBeNull();
    await app.close();
  });

  it("blocks EVERY browser origin when the list is empty — never reflect-any", async () => {
    // The pre-Phase-2 behaviour reflected whatever origin asked, letting any
    // website on the internet call this API from a victim's browser.
    const app = await serverWith("", "production");
    expect(await allowOriginFor(app, ADMIN_ORIGIN)).toBeNull();
    expect(await allowOriginFor(app, "https://evil.example")).toBeNull();
    await app.close();
  });

  it("still grants the origin when the env var was pasted with a trailing slash", async () => {
    // The exact shape of the outage: correct-looking dashboard value, and
    // every admin request blocked.
    const app = await serverWith(`${ADMIN_ORIGIN}/`, "production");
    expect(await allowOriginFor(app, ADMIN_ORIGIN)).toBe(ADMIN_ORIGIN);
    await app.close();
  });

  it("grants every entry of a multi-origin list written with spaces and slashes", async () => {
    const app = await serverWith(
      `  ${ADMIN_ORIGIN}/ , https://campusride.example/  `,
      "production",
    );
    expect(await allowOriginFor(app, ADMIN_ORIGIN)).toBe(ADMIN_ORIGIN);
    expect(await allowOriginFor(app, "https://campusride.example")).toBe("https://campusride.example");
    expect(await allowOriginFor(app, "https://campusride.example.evil.com")).toBeNull();
    await app.close();
  });
});

describe("Requests with no Origin header (the native rider/driver apps)", () => {
  /**
   * React Native's fetch/axios send no Origin header, so CORS never engages
   * for the mobile apps. These cases pin that: the strictest possible policy
   * must not break them, or a CORS tightening would take the whole product
   * down while looking like a browser-only change.
   */
  it("succeeds under the strictest production policy (empty allowlist)", async () => {
    const app = await serverWith("", "production");
    expect(await allowOriginFor(app)).toBeNull(); // no header needed, and none sent
    await app.close();
  });

  it("succeeds when an allowlist is configured that would not match them", async () => {
    const app = await serverWith(ADMIN_ORIGIN, "production");
    expect(await allowOriginFor(app)).toBeNull();
    await app.close();
  });

  it("returns the real response body, not an error", async () => {
    const app = await serverWith("", "production");
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});

describe("CORS policy outside production", () => {
  it("reflects any origin when the list is empty, for local dev tooling", async () => {
    const app = await serverWith("", "development");
    expect(await allowOriginFor(app, "http://localhost:5173")).toBe("http://localhost:5173");
    await app.close();
  });

  it("still honours an explicit list outside production", async () => {
    const app = await serverWith("http://localhost:5173", "development");
    expect(await allowOriginFor(app, "http://localhost:5173")).toBe("http://localhost:5173");
    expect(await allowOriginFor(app, "https://evil.example")).toBeNull();
    await app.close();
  });
});

describe("HTTP and Socket.io share one policy", () => {
  /**
   * index.ts computes `corsOrigin` ONCE and passes the same value to
   * app.register(cors, ...) and to `new SocketServer(..., { cors: { origin } })`.
   * Socket.io's handshake is a normal browser XHR/WebSocket upgrade carrying an
   * Origin header, so a divergence here would leave the realtime channel open
   * to origins the HTTP API rejects. This pins that they are computed from the
   * same input rather than duplicated.
   */
  it("resolves one value for both transports from the same env string", () => {
    const raw = `${ADMIN_ORIGIN}/, https://campusride.example`;
    const resolved = resolveCorsOrigin(parseOriginAllowlist(raw), "production");
    expect(resolved).toEqual([ADMIN_ORIGIN, "https://campusride.example"]);
    // Same call, same inputs — whatever HTTP gets, Socket.io gets.
    expect(resolveCorsOrigin(parseOriginAllowlist(raw), "production")).toEqual(resolved);
  });
});
