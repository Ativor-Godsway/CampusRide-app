import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import {
  RENDER_TRUSTED_PROXIES,
  isDevLoopbackExempt,
  isProxyAddress,
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
  it("defaults to Render's proxy ranges in production (private networks and Cloudflare)", () => {
    expect(resolveTrustProxy(undefined, "production")).toBe(RENDER_TRUSTED_PROXIES);
    expect(resolveTrustProxy("", "production")).toBe(RENDER_TRUSTED_PROXIES);
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

describe("isDevLoopbackExempt", () => {
  it("exempts this machine only on a development server", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isDevLoopbackExempt(ip, "development")).toBe(true);
    }
  });

  it("never exempts anything in production or under the test suite", () => {
    expect(isDevLoopbackExempt("127.0.0.1", "production")).toBe(false);
    expect(isDevLoopbackExempt("127.0.0.1", "test")).toBe(false);
  });

  it("keeps the phone on the Wi-Fi rate-limited", () => {
    expect(isDevLoopbackExempt("192.168.1.40", "development")).toBe(false);
  });
});

/**
 * PROOF that request.ip is the real client behind Render. A request reaches
 * the server as client -> Cloudflare -> Render's load balancer -> us; each
 * hop appends the address it received from to X-Forwarded-For, and the TCP
 * peer is Render's internal proxy. (Observed on Render: a spoofed value stays
 * on the left and the real client is appended after it, then Cloudflare,
 * then a 10.x address.) These build a server exactly as index.ts does in
 * production and replay that chain.
 */
describe("request.ip behind Render, with the production trustProxy", () => {
  async function ipSeen(forwardedFor: string | undefined, remoteAddress = "10.204.7.21"): Promise<string> {
    const app = Fastify({ trustProxy: toFastifyTrustProxy(resolveTrustProxy(undefined, "production")) });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress,
      headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    });
    await app.close();
    return res.json().ip;
  }

  it("is the client, not Render's load balancer or Cloudflare", async () => {
    expect(await ipSeen("41.66.200.17, 172.71.140.5, 10.17.3.9")).toBe("41.66.200.17");
  });

  it("can't be forged: a client's own X-Forwarded-For is to the left of what the proxies append", async () => {
    expect(await ipSeen("1.2.3.4, 41.66.200.17, 172.71.140.5, 10.17.3.9")).toBe("41.66.200.17");
    expect(await ipSeen("10.0.0.1, 41.66.200.17, 172.71.140.5, 10.17.3.9")).toBe("41.66.200.17");
  });

  it("works for IPv6 clients and Cloudflare's IPv6 edge", async () => {
    expect(await ipSeen("2c0f:2a80:10:1::5, 2606:4700:10::ac43:1a2b, 10.17.3.9")).toBe("2c0f:2a80:10:1::5");
  });

  it("tells two students on different networks apart, and two on one hostel Wi-Fi together", async () => {
    const hostel = await ipSeen("154.160.1.20, 172.71.140.5, 10.17.3.9");
    const sameHostel = await ipSeen("154.160.1.20, 162.158.22.4, 10.17.3.10");
    const mobileData = await ipSeen("102.176.65.3, 172.71.140.5, 10.17.3.9");
    expect(hostel).toBe(sameHostel);
    expect(hostel).not.toBe(mobileData);
  });

  it("with the old one-hop setting, every request looked like Render's load balancer", async () => {
    const app = Fastify({ trustProxy: toFastifyTrustProxy(1) });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const seen = new Set<string>();
    for (const client of ["41.66.200.17", "102.176.65.3", "154.160.1.20"]) {
      const res = await app.inject({
        method: "GET",
        url: "/ip",
        remoteAddress: "10.204.7.21",
        headers: { "x-forwarded-for": `${client}, 172.71.140.5, 10.17.3.9` },
      });
      seen.add(res.json().ip);
    }
    await app.close();
    expect([...seen]).toEqual(["10.17.3.9"]); // three people, one "IP"
  });
});

describe("isProxyAddress", () => {
  it("flags private, loopback, carrier-NAT and Cloudflare addresses, in both families", () => {
    for (const ip of ["10.17.3.9", "172.16.0.1", "192.168.1.5", "127.0.0.1", "::1", "::ffff:10.1.2.3", "100.64.3.2", "172.71.140.5", "104.16.0.1", "2606:4700::1", "fd00::1", "fe80::1", "not-an-ip"]) {
      expect(isProxyAddress(ip), ip).toBe(true);
    }
  });

  it("lets real client addresses through", () => {
    for (const ip of ["41.66.200.17", "154.160.1.20", "102.176.65.3", "::ffff:41.66.200.17", "2c0f:2a80:10:1::5"]) {
      expect(isProxyAddress(ip), ip).toBe(false);
    }
  });
});
