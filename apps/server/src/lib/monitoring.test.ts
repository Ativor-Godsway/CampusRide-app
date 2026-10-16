/**
 * Stage 5: what the server sends to Sentry, captured by a fake transport
 * instead of the network. Off without a DSN; with one, real 500s are reported
 * with their request id and scrubbed, and nothing else is.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { NodeOptions } from "@sentry/node";
import { installErrorHandling } from "../http/errors";
import { useRequestValidation } from "../http/validation";
import { empty, object, text } from "../http/schemas";
import {
  DEFAULT_TRACES_SAMPLE_RATE,
  flushMonitoring,
  initMonitoring,
  monitoringEnabled,
  reportMessage,
  sentryOptions,
  tracesSampleRate,
} from "./monitoring";

type Envelope = [unknown, Array<[{ type: string }, Record<string, unknown>]>];
const events: Array<Record<string, unknown>> = [];

const fakeTransport: NodeOptions["transport"] = () => ({
  send: async (envelope) => {
    for (const [header, payload] of (envelope as unknown as Envelope)[1]) {
      if (header.type === "event") events.push(payload);
    }
    return {};
  },
  flush: async () => true,
});

describe("without SENTRY_DSN", () => {
  it("is off, and reporting does nothing", () => {
    expect(sentryOptions({})).toBeNull();
    expect(sentryOptions({ SENTRY_DSN: "  " })).toBeNull();
    expect(initMonitoring({})).toBe(false);
    expect(monitoringEnabled()).toBe(false);
    expect(() => reportMessage("nothing")).not.toThrow();
  });
});

describe("settings", () => {
  const DSN = "https://examplePublicKey@o0.ingest.sentry.io/0";

  it("tags the deployed commit and environment", () => {
    const options = sentryOptions({
      SENTRY_DSN: DSN,
      NODE_ENV: "production",
      RENDER_GIT_COMMIT: "abc123",
    });
    expect(options).toMatchObject({
      dsn: DSN,
      environment: "production",
      release: "abc123",
      sendDefaultPii: false,
    });
    expect(
      sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "staging", SENTRY_RELEASE: "v2" }),
    ).toMatchObject({
      environment: "staging",
      release: "v2",
    });
  });

  it("samples a small share of requests for performance", () => {
    expect(DEFAULT_TRACES_SAMPLE_RATE).toBe(0.02);
    expect(tracesSampleRate(undefined)).toBe(0.02);
    expect(tracesSampleRate("0.1")).toBe(0.1);
    expect(tracesSampleRate("0")).toBe(0);
    for (const bad of ["", "abc", "5", "-1"]) expect(tracesSampleRate(bad)).toBe(0.02);
  });
});

describe("with SENTRY_DSN", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    expect(
      initMonitoring(
        { SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0", NODE_ENV: "test" },
        { transport: fakeTransport, tracesSampleRate: 0 },
      ),
    ).toBe(true);
    app = Fastify();
    useRequestValidation(app);
    installErrorHandling(app);
    app.post("/boom", { schema: { body: object({ phone: text(40) }) } }, async (request) => {
      throw new Error(`no account for ${(request.body as { phone: string }).phone}`);
    });
    app.get("/refused", { schema: { querystring: empty } }, async (_request, reply) =>
      reply.code(409).send({ error: "Already done" }),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function sentAfter(action: () => Promise<unknown>) {
    const before = events.length;
    await action();
    await flushMonitoring();
    return events.slice(before);
  }

  it("reports a 500 once, with its request id and nothing personal", async () => {
    let requestId = "";
    const sent = await sentAfter(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/boom?phone=0548617146",
        headers: { authorization: "Bearer secret-token", cookie: "a=b" },
        payload: { phone: "0548617146" },
      });
      expect(res.statusCode).toBe(500);
      requestId = res.json().requestId;
    });
    expect(sent).toHaveLength(1);
    const event = sent[0]!;
    expect((event.tags as Record<string, string>).requestId).toBe(requestId);
    expect((event.tags as Record<string, string>).route).toBe("/boom");
    const text = JSON.stringify(event);
    expect(text).toContain("no account for +233*****146");
    for (const leak of ["548617146", "secret-token", "a=b"]) expect(text, leak).not.toContain(leak);
  });

  it("doesn't report what isn't a server fault (400, 404, a route's own 409)", async () => {
    const sent = await sentAfter(async () => {
      await app.inject({ method: "POST", url: "/boom", payload: { phone: 5 } });
      await app.inject({ method: "GET", url: "/nowhere" });
      await app.inject({ method: "GET", url: "/refused" });
    });
    expect(sent).toEqual([]);
  });

  it("scrubs a reported message", async () => {
    const sent = await sentAfter(async () =>
      reportMessage("SMS to 0548617146 failed", { tags: { alert: "sms_failed" } }),
    );
    expect(sent[0]).toMatchObject({
      message: "SMS to +233*****146 failed",
      level: "error",
      tags: { alert: "sms_failed" },
    });
  });
});
