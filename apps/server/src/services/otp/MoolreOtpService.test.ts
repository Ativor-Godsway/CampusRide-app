import { describe, it, expect, vi } from "vitest";
import { MoolreOtpService } from "./MoolreOtpService";

const CFG = {
  baseUrl: "https://sandbox.moolre.com",
  apiUser: "test-user",
  vasKey: "test-vas-key",
  senderId: "CampusRide",
};

function mockFetch(responseBody: unknown, ok = true) {
  return vi.fn(async () => ({
    ok,
    json: async () => responseBody,
  })) as unknown as typeof fetch;
}

describe("MoolreOtpService.sendOtp", () => {
  it("POSTs to /open/sms/send with the correct headers, body shape, and message containing the code", async () => {
    const fetchFn = mockFetch({ status: 1 });
    const service = new MoolreOtpService(CFG, fetchFn);

    const result = await service.sendOtp("+233200000001", "123456");

    expect(result.success).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];

    expect(url).toBe("https://sandbox.moolre.com/open/sms/send");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-VASKEY"]).toBe("test-vas-key");
    expect(headers["X-API-USER"]).toBe("test-user");

    const body = JSON.parse(init.body as string) as {
      type: number;
      senderid: string;
      messages: { recipient: string; message: string; ref: string }[];
    };
    expect(body.senderid).toBe("CampusRide");
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.recipient).toBe("233200000001");
    expect(body.messages[0]!.message).toContain("123456");
    expect(body.messages[0]!.ref).toContain("otp:");
  });

  it("returns success: false when the response status is not 1", async () => {
    const fetchFn = mockFetch({ status: 0 });
    const service = new MoolreOtpService(CFG, fetchFn);

    const result = await service.sendOtp("+233200000002", "654321");
    expect(result.success).toBe(false);
  });

  it("returns success: false on a non-OK HTTP response", async () => {
    const fetchFn = mockFetch({ status: 1 }, false);
    const service = new MoolreOtpService(CFG, fetchFn);

    const result = await service.sendOtp("+233200000003", "111111");
    expect(result.success).toBe(false);
  });

  it("never includes the raw OTP code in the request URL or headers (only in the message body)", async () => {
    const fetchFn = mockFetch({ status: 1 });
    const service = new MoolreOtpService(CFG, fetchFn);

    await service.sendOtp("+233200000004", "999999");
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];

    expect(url).not.toContain("999999");
    expect(JSON.stringify(init.headers)).not.toContain("999999");
  });
});
