import { describe, it, expect } from "vitest";
import {
  parseOriginAllowlist,
  resolveCorsOrigin,
  resolveTrustProxy,
  toFastifyTrustProxy,
} from "./security";

describe("parseOriginAllowlist", () => {
  it("splits, trims and drops blanks", () => {
    expect(parseOriginAllowlist("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(parseOriginAllowlist("https://a.com,,  ,")).toEqual(["https://a.com"]);
  });

  it("treats an empty/whitespace value as no allowlist (not an origin named '')", () => {
    expect(parseOriginAllowlist("")).toEqual([]);
    expect(parseOriginAllowlist("   ")).toEqual([]);
    expect(parseOriginAllowlist(",,,")).toEqual([]);
  });

  /**
   * A browser's Origin header is scheme+host+port with NO path and no trailing
   * slash, and @fastify/cors compares it to the allowlist as a plain string.
   * A value pasted from a URL bar or a Render dashboard usually carries the
   * slash, which used to match nothing while looking perfectly correct — the
   * failure mode that took the admin site down.
   */
  it("strips trailing slashes so a pasted URL still matches a real Origin header", () => {
    expect(parseOriginAllowlist("https://campusride-admin.onrender.com/")).toEqual([
      "https://campusride-admin.onrender.com",
    ]);
    expect(parseOriginAllowlist("https://a.com///")).toEqual(["https://a.com"]);
  });

  it("handles spaces and trailing slashes together, the way a pasted list arrives", () => {
    expect(
      parseOriginAllowlist("  https://a.com/ ,\thttps://b.com ,  https://c.com//  "),
    ).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
  });

  it("does not mangle a bare origin that was already correct", () => {
    expect(parseOriginAllowlist("https://a.com,http://localhost:5173")).toEqual([
      "https://a.com",
      "http://localhost:5173",
    ]);
  });
});

describe("resolveCorsOrigin", () => {
  it("uses the allowlist whenever one is configured, in every environment", () => {
    const list = ["https://showcase.example"];
    expect(resolveCorsOrigin(list, "production")).toEqual(list);
    expect(resolveCorsOrigin(list, "development")).toEqual(list);
  });

  it("denies every browser origin in production when the allowlist is empty", () => {
    // The pre-Phase-2 behaviour was `true` here: any site could call the API
    // from a victim's browser. That is the regression this guards.
    expect(resolveCorsOrigin([], "production")).toBe(false);
  });

  it("reflects any origin outside production only", () => {
    expect(resolveCorsOrigin([], "development")).toBe(true);
    expect(resolveCorsOrigin([], "test")).toBe(true);
  });
});

describe("resolveTrustProxy", () => {
  it("defaults to a single hop in production (Render's TLS proxy)", () => {
    expect(resolveTrustProxy(undefined, "production")).toBe(1);
    expect(resolveTrustProxy("", "production")).toBe(1);
  });

  it("defaults to trusting nothing outside production", () => {
    expect(resolveTrustProxy(undefined, "development")).toBe(false);
    expect(resolveTrustProxy(undefined, "test")).toBe(false);
  });

  it("accepts an explicit hop count", () => {
    expect(resolveTrustProxy("2", "production")).toBe(2);
    expect(resolveTrustProxy("0", "production")).toBe(0);
    expect(resolveTrustProxy(" 3 ", "production")).toBe(3);
  });

  it("passes a non-numeric value through as an IP/CIDR allowlist", () => {
    expect(resolveTrustProxy("10.0.0.0/8,192.168.0.0/16", "production")).toBe(
      "10.0.0.0/8,192.168.0.0/16",
    );
    expect(resolveTrustProxy("loopback", "production")).toBe("loopback");
  });

  it("never returns `true`, which would trust a spoofable forwarded chain", () => {
    for (const raw of [undefined, "", "1", "5", "10.0.0.0/8", "loopback"]) {
      expect(resolveTrustProxy(raw, "production")).not.toBe(true);
    }
  });
});

describe("toFastifyTrustProxy", () => {
  it("passes strings and booleans through untouched", () => {
    expect(toFastifyTrustProxy("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(toFastifyTrustProxy(false)).toBe(false);
  });

  it("turns a hop count into a predicate trusting exactly that many hops", () => {
    const trust = toFastifyTrustProxy(1);
    expect(typeof trust).toBe("function");
    const fn = trust as (address: string, hop: number) => boolean;
    expect(fn("1.2.3.4", 0)).toBe(true);
    // The second hop is client-supplied and must NOT be trusted, which is
    // what stops X-Forwarded-For spoofing from resetting the rate-limit key.
    expect(fn("1.2.3.4", 1)).toBe(false);
    expect(fn("1.2.3.4", 5)).toBe(false);
  });

  it("supports multiple hops", () => {
    const fn = toFastifyTrustProxy(2) as (address: string, hop: number) => boolean;
    expect(fn("1.2.3.4", 0)).toBe(true);
    expect(fn("1.2.3.4", 1)).toBe(true);
    expect(fn("1.2.3.4", 2)).toBe(false);
  });

  it("collapses 0 hops to false rather than a never-true predicate", () => {
    expect(toFastifyTrustProxy(0)).toBe(false);
  });
});
