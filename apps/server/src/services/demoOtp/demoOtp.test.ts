import { createHash } from "node:crypto";
import { describe, it, expect, afterEach, afterAll } from "vitest";
import type { OtpResult, OtpService } from "../otp/OtpService";
import { prisma } from "../../db/prisma";
import {
  requestDemoOtp,
  verifyDemoOtp,
  normalizeDemoPhone,
  type DemoOtpDeps,
  type DemoOtpLimits,
} from "./demoOtp";
import { CapturingOtpService } from "../auth/testFixtures";

const BASE_LIMITS: DemoOtpLimits = {
  ttlMinutes: 5,
  codeLength: 6,
  maxVerifyAttempts: 5,
  perPhoneMinIntervalSeconds: 60,
  perPhoneMaxPerDay: 100,
  perIpMaxPerHour: 100,
  globalMaxPerDay: 100_000,
  retentionHours: 24,
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

let counter = 0;
const phones: string[] = [];

/** Unique, VALID Ghanaian local-format number ("0XXXXXXXXX") per call. */
function newPhone(): string {
  counter += 1;
  const n = 200_000_000 + ((Date.now() + counter) % 700_000_000); // 9 digits
  const phone = `0${n}`;
  phones.push(phone);
  return phone;
}

const msisdnPlus = (local: string) => `+233${local.slice(1)}`;

function deps(over: Partial<DemoOtpLimits> = {}, now?: Date): DemoOtpDeps & { otpService: CapturingOtpService } {
  return {
    prisma,
    otpService: new CapturingOtpService(),
    limits: { ...BASE_LIMITS, ...over },
    ...(now ? { now } : {}),
  };
}

afterEach(async () => {
  while (phones.length > 0) {
    await prisma.demoOtp.deleteMany({ where: { phone: phones.pop()! } });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("normalizeDemoPhone", () => {
  it("normalizes +233/233/0 forms to local + msisdn, rejects junk", () => {
    expect(normalizeDemoPhone("+233594826328")).toEqual({ local: "0594826328", msisdnPlus: "+233594826328" });
    expect(normalizeDemoPhone("233594826328")).toEqual({ local: "0594826328", msisdnPlus: "+233594826328" });
    expect(normalizeDemoPhone("0594826328")).toEqual({ local: "0594826328", msisdnPlus: "+233594826328" });
    expect(normalizeDemoPhone("059 482 6328")).toEqual({ local: "0594826328", msisdnPlus: "+233594826328" });
    expect(normalizeDemoPhone("12345")).toBeNull();
    expect(normalizeDemoPhone("not-a-phone")).toBeNull();
  });
});

describe("requestDemoOtp", () => {
  it("stores a sha256 hash (never the raw code) and sends a 6-digit code", async () => {
    const phone = newPhone();
    const d = deps();

    const res = await requestDemoOtp(d, { phone, ip: "1.1.1.1" });
    expect(res).toEqual({ ok: true });

    const code = d.otpService.sent.get(msisdnPlus(phone));
    expect(code).toMatch(/^\d{6}$/);

    const row = await prisma.demoOtp.findFirst({ where: { phone } });
    expect(row).not.toBeNull();
    expect(row!.codeHash).toBe(sha256(code!));
    expect(row!.codeHash).not.toBe(code);
    expect(row!.attempts).toBe(0);
    expect(row!.ip).toBe("1.1.1.1");
  });

  it("rejects an invalid phone with 400 and never sends", async () => {
    const d = deps();
    const res = await requestDemoOtp(d, { phone: "12345", ip: null });
    expect(res).toEqual({ ok: false, status: 400, reason: expect.any(String) });
    expect(d.otpService.sent.size).toBe(0);
  });

  it("enforces the per-phone min interval (max 1 / 60s)", async () => {
    const phone = newPhone();
    const now = new Date("2026-03-01T00:00:00Z");
    const d = deps({}, now);

    expect(await requestDemoOtp(d, { phone, ip: "1.1.1.1" })).toEqual({ ok: true });
    const second = await requestDemoOtp({ ...d, now: new Date(now.getTime() + 30_000) }, { phone, ip: "1.1.1.1" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(429);

    // After the interval, a new send is allowed again.
    const third = await requestDemoOtp({ ...d, now: new Date(now.getTime() + 61_000) }, { phone, ip: "1.1.1.1" });
    expect(third).toEqual({ ok: true });
  });

  it("enforces the per-phone daily cap", async () => {
    const phone = newPhone();
    const base = new Date("2026-03-02T00:00:00Z");
    const d = deps({ perPhoneMaxPerDay: 3 });

    for (let i = 0; i < 3; i++) {
      const now = new Date(base.getTime() + i * 2 * 60_000); // 2 min apart (clears 60s interval)
      expect(await requestDemoOtp({ ...d, now }, { phone, ip: "1.1.1.1" })).toEqual({ ok: true });
    }
    const over = await requestDemoOtp({ ...d, now: new Date(base.getTime() + 99 * 60_000) }, { phone, ip: "1.1.1.1" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
  });

  it("enforces the per-IP hourly cap across different phones", async () => {
    const base = new Date("2026-03-03T00:00:00Z");
    const d = deps({ perIpMaxPerHour: 2 });
    const ip = "9.9.9.9";

    for (let i = 0; i < 2; i++) {
      const now = new Date(base.getTime() + i * 60_000);
      expect(await requestDemoOtp({ ...d, now }, { phone: newPhone(), ip })).toEqual({ ok: true });
    }
    const over = await requestDemoOtp({ ...d, now: new Date(base.getTime() + 3 * 60_000) }, { phone: newPhone(), ip });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
  });

  it("enforces the global daily cap", async () => {
    const base = new Date("2026-03-04T00:00:00Z");
    const d = deps({ globalMaxPerDay: 2 });

    for (let i = 0; i < 2; i++) {
      const now = new Date(base.getTime() + i * 60_000);
      expect(await requestDemoOtp({ ...d, now }, { phone: newPhone(), ip: `10.0.0.${i}` })).toEqual({ ok: true });
    }
    const over = await requestDemoOtp({ ...d, now: new Date(base.getTime() + 3 * 60_000) }, { phone: newPhone(), ip: "10.0.0.9" });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.status).toBe(429);
  });

  it("does not count a failed send against limits (row removed)", async () => {
    const phone = newPhone();
    const failing: OtpService = { async sendOtp(): Promise<OtpResult> { return { success: false }; } };
    const res = await requestDemoOtp({ prisma, otpService: failing, limits: BASE_LIMITS }, { phone, ip: "2.2.2.2" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(502);
    expect(await prisma.demoOtp.count({ where: { phone } })).toBe(0);
  });
});

describe("verifyDemoOtp", () => {
  async function send(phone: string, d: ReturnType<typeof deps>): Promise<string> {
    await requestDemoOtp(d, { phone, ip: "1.1.1.1" });
    return d.otpService.sent.get(msisdnPlus(phone))!;
  }

  it("succeeds on the correct code and invalidates it (single use)", async () => {
    const phone = newPhone();
    const d = deps();
    const code = await send(phone, d);

    expect(await verifyDemoOtp(d, { phone, code })).toEqual({ ok: true });
    expect(await prisma.demoOtp.count({ where: { phone } })).toBe(0);

    // Reuse now fails — no active code.
    const reuse = await verifyDemoOtp(d, { phone, code });
    expect(reuse.ok).toBe(false);
  });

  it("rejects a wrong code and increments attempts", async () => {
    const phone = newPhone();
    const d = deps();
    await send(phone, d);

    const res = await verifyDemoOtp(d, { phone, code: "000000" });
    expect(res.ok).toBe(false);
    const row = await prisma.demoOtp.findFirst({ where: { phone } });
    expect(row!.attempts).toBe(1);
  });

  it("invalidates after the attempt cap, forcing a re-send", async () => {
    const phone = newPhone();
    const d = deps({ maxVerifyAttempts: 3 });
    const code = await send(phone, d);

    expect((await verifyDemoOtp(d, { phone, code: "000000" })).ok).toBe(false);
    expect((await verifyDemoOtp(d, { phone, code: "000000" })).ok).toBe(false);
    // 3rd wrong attempt hits the cap -> row deleted.
    expect((await verifyDemoOtp(d, { phone, code: "000000" })).ok).toBe(false);
    expect(await prisma.demoOtp.count({ where: { phone } })).toBe(0);

    // Even the correct code now fails — it was invalidated.
    expect((await verifyDemoOtp(d, { phone, code })).ok).toBe(false);
  });

  it("rejects an expired code", async () => {
    const phone = newPhone();
    const now = new Date("2026-03-05T00:00:00Z");
    const d = deps({}, now);
    const code = await send(phone, d);

    const afterExpiry = new Date(now.getTime() + (BASE_LIMITS.ttlMinutes + 1) * 60_000);
    const res = await verifyDemoOtp({ ...d, now: afterExpiry }, { phone, code });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
    expect(await prisma.demoOtp.count({ where: { phone } })).toBe(0);
  });

  it("rejects an invalid phone with 400", async () => {
    const res = await verifyDemoOtp(deps(), { phone: "nope", code: "123456" });
    expect(res).toEqual({ ok: false, status: 400, reason: expect.any(String) });
  });
});
