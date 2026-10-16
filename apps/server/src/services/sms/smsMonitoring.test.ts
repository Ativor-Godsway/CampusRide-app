/** Stage 5: a failed SMS is reported (without the number or the text); a low balance warns. */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as monitoring from "../../lib/monitoring";
import { sendMoolreSms } from "./MoolreSmsService";
import { createBalanceCheck, readMoolreSmsBalance } from "./moolreBalance";

const cfg = {
  baseUrl: "https://moolre.test",
  apiUser: "user",
  vasKey: "vas-key",
  senderId: "CampusRide",
};

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a failed SMS send", () => {
  it("is reported when Moolre refuses it, without the number or the code", async () => {
    const report = vi.spyOn(monitoring, "reportMessage");
    const result = await sendMoolreSms(cfg, "+233548617146", "Your CampusRide code is 482913.", {
      refPrefix: "otp",
      fetchFn: fakeFetch(200, {
        status: 0,
        code: "SMS_INSUFFICIENT",
        message: "Insufficient balance",
      }),
    });
    expect(result).toEqual({ success: false });
    expect(report).toHaveBeenCalledOnce();
    const [message, context] = report.mock.calls[0]!;
    expect(message).toBe("SMS send failed (Moolre)");
    expect(context).toMatchObject({
      tags: { alert: "sms_failed", provider: "moolre", purpose: "otp" },
    });
    expect(context!.extra).toMatchObject({ moolreCode: "SMS_INSUFFICIENT", moolreStatus: 0 });
    const text = JSON.stringify([message, context]);
    expect(text).not.toContain("548617146");
    expect(text).not.toContain("482913");
  });

  it("is reported on an HTTP error", async () => {
    const report = vi.spyOn(monitoring, "reportMessage");
    await sendMoolreSms(cfg, "+233548617146", "hi", { fetchFn: fakeFetch(502, {}) });
    expect(report.mock.calls[0]![1]!.extra).toEqual({ httpStatus: 502 });
  });

  it("is reported, and still thrown, when Moolre can't be reached", async () => {
    const report = vi.spyOn(monitoring, "reportError");
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(
      sendMoolreSms(cfg, "+233548617146", "hi", { refPrefix: "ride", fetchFn: down }),
    ).rejects.toThrow("fetch failed");
    expect(report).toHaveBeenCalledWith(expect.any(TypeError), {
      tags: { alert: "sms_failed", provider: "moolre", purpose: "ride" },
    });
  });

  it("isn't reported when it works", async () => {
    const report = vi.spyOn(monitoring, "reportMessage");
    const result = await sendMoolreSms(cfg, "+233548617146", "hi", {
      fetchFn: fakeFetch(200, { status: 1 }),
    });
    expect(result).toEqual({ success: true });
    expect(report).not.toHaveBeenCalled();
  });
});

describe("the Moolre SMS balance", () => {
  it("is read from data.balance, with the VAS key", async () => {
    let request: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      request = { url, init };
      return new Response(JSON.stringify({ status: 1, data: { balance: "250" } }));
    }) as unknown as typeof fetch;
    expect(await readMoolreSmsBalance(cfg, fetchFn)).toBe(250);
    expect(request!.url).toBe("https://moolre.test/open/sms/query");
    expect(JSON.parse(String(request!.init.body))).toEqual({ type: 2 });
    expect((request!.init.headers as Record<string, string>)["X-API-VASKEY"]).toBe("vas-key");
  });

  it("is null when it can't be read", async () => {
    expect(await readMoolreSmsBalance(cfg, fakeFetch(404, {}))).toBeNull();
    expect(await readMoolreSmsBalance(cfg, fakeFetch(200, { data: {} }))).toBeNull();
    expect(await readMoolreSmsBalance(cfg, fakeFetch(200, "nope"))).toBeNull();
  });

  it("warns when low, at most once a day", async () => {
    let now = 0;
    const report = vi.fn();
    const check = createBalanceCheck({
      cfg,
      lowBalance: 100,
      report,
      now: () => now,
      fetchFn: fakeFetch(200, { data: { balance: 40 } }),
    });
    await check();
    now += 6 * 60 * 60_000;
    await check();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("Moolre SMS balance is low: 40 left", {
      level: "warning",
      tags: { alert: "moolre_balance_low" },
      extra: { balance: 40, lowBalance: 100 },
    });
    now += 24 * 60 * 60_000;
    await check();
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when there is enough", async () => {
    const report = vi.fn();
    await createBalanceCheck({
      cfg,
      lowBalance: 100,
      report,
      fetchFn: fakeFetch(200, { data: { balance: 500 } }),
    })();
    expect(report).not.toHaveBeenCalled();
  });

  it("says once that it can't be read, so it gets checked by hand", async () => {
    const report = vi.fn();
    const check = createBalanceCheck({ cfg, lowBalance: 100, report, fetchFn: fakeFetch(500, {}) });
    await check();
    await check();
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![1]).toMatchObject({
      level: "warning",
      tags: { alert: "moolre_balance_unreadable" },
    });
  });
});
