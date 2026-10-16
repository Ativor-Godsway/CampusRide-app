import { describe, expect, it } from "vitest";
import { redactText } from "./redact";
import { scrubSentryBreadcrumb, scrubSentryEvent } from "./sentryEvent";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const EVENT_ID = "c9a1f1e2d3b44f5a8b7c6d5e4f3a2b1c";

describe("redactText without lookbehind", () => {
  it("masks numbers side by side, at the start and after letters", () => {
    expect(redactText("0241234567,0241234568")).toBe("+233*****567,+233*****568");
    expect(redactText("to:0548617146")).toBe("to:+233*****146");
    expect(redactText("x0548617146")).toBe("x+233*****146");
  });

  it("leaves longer runs of digits alone", () => {
    expect(redactText("10548617146")).toBe("10548617146");
    expect(redactText("05486171460")).toBe("05486171460");
  });

  it("masks hex tokens but not shorter hex", () => {
    expect(redactText(`id=${"ab".repeat(16)}`)).toBe("id=[hex]");
    expect(redactText("sha 9f2c41aa")).toBe("sha 9f2c41aa");
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs everything that can carry a person's data", () => {
    const event = scrubSentryEvent({
      event_id: EVENT_ID,
      message: "SMS to 0548617146 failed",
      logentry: { message: "code for %s", params: ["+233548617146"] },
      exception: {
        values: [
          {
            type: "Error",
            value: "no account for 233548617146",
            stacktrace: {
              frames: [
                { filename: "app:///index.bundle", lineno: 3, vars: { phone: "0548617146" } },
              ],
            },
          },
        ],
      },
      breadcrumbs: [
        {
          category: "http",
          data: { url: "https://api.campusride.app/track/9f2c41aa", method: "GET" },
        },
        {
          category: "console",
          message: "verifiedToken eyJhbGciOiJIUzI1NiJ9.eyJwaG9uZSI6IngifQ.c2lnbmF0dXJl",
        },
      ],
      request: {
        url: "https://api.campusride.app/admin/rate-limits?phone=0548617146",
        query_string: "phone=0548617146",
        data: { phone: "0548617146", code: "123456" },
        cookies: { session: "x" },
        headers: { Authorization: "Bearer abc", "User-Agent": "okhttp", "x-api-vaskey": "k" },
      },
      extra: { body: { refreshToken: "r", nested: { pushToken: "ExponentPushToken[abc]" } } },
      tags: { phone: "0548617146", route: "/auth/verify-otp" },
      contexts: {
        trace: {
          trace_id: TRACE_ID,
          span_id: "a1b2c3d4e5f60718",
          data: { "url.full": "/track/9f2c41aa" },
        },
        app: { note: "rider +233548617146" },
      },
      user: { id: "ck123", ip_address: "41.66.1.2", phone: "0548617146" },
      spans: [
        {
          span_id: "b1",
          trace_id: TRACE_ID,
          description: "GET /track/9f2c41aa",
          data: { "http.query": "phone=0548617146" },
        },
      ],
    });

    const text = JSON.stringify(event);
    for (const leak of [
      "548617146",
      "9f2c41aa",
      "123456",
      "Bearer",
      "eyJ",
      "ExponentPushToken[abc]",
      "41.66.1.2",
      '"r"',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(event.message).toBe("SMS to +233*****146 failed");
    expect(event.exception.values[0]!.value).toBe("no account for +233*****146");
    expect(event.exception.values[0]!.stacktrace.frames[0]).toEqual({
      filename: "app:///index.bundle",
      lineno: 3,
    });
    expect(event.request).toEqual({
      url: "https://api.campusride.app/admin/rate-limits?phone=+233*****146",
      query_string: "phone=+233*****146",
      headers: { "User-Agent": "okhttp" },
    });
    expect(event.user).toEqual({ id: "ck123" });
    expect(event.extra.body.refreshToken).toBe("[redacted]");
  });

  it("keeps the ids Sentry needs", () => {
    const event = scrubSentryEvent({
      event_id: EVENT_ID,
      contexts: { trace: { trace_id: TRACE_ID, span_id: "a1b2c3d4e5f60718" } },
      spans: [{ trace_id: TRACE_ID, span_id: "c1", description: "db" }],
    });
    expect(event.event_id).toBe(EVENT_ID);
    expect(event.contexts.trace.trace_id).toBe(TRACE_ID);
    expect(event.spans[0]!.trace_id).toBe(TRACE_ID);
  });

  it("drops a user with no id", () => {
    expect(scrubSentryEvent({ user: { ip_address: "1.2.3.4" } })).toEqual({});
  });

  it("scrubs a breadcrumb on its own", () => {
    expect(scrubSentryBreadcrumb({ message: "GET /track/abc", data: { token: "x" } })).toEqual({
      message: "GET /track/[token]",
      data: { token: "[redacted]" },
    });
  });
});
