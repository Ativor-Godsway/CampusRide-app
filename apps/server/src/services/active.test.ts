import { describe, it, expect } from "vitest";
import { resolveOtpService, type OtpProviderConfig } from "./active";
import { DummyOtpService } from "./otp/DummyOtpService";
import { MnotifyOtpService } from "./otp/MnotifyOtpService";
import { MoolreOtpService } from "./otp/MoolreOtpService";

function baseConfig(overrides: Partial<OtpProviderConfig> = {}): OtpProviderConfig {
  return {
    otpProvider: "dummy",
    moolre: { enabled: false, baseUrl: "https://sandbox.moolre.com", apiUser: "", vasKey: "", smsSenderId: "" },
    mnotify: { enabled: false, apiKey: "", senderId: "CampusRide" },
    ...overrides,
  };
}

describe("resolveOtpService — OTP_PROVIDER precedence", () => {
  it("defaults to DummyOtpService when OTP_PROVIDER is unset/dummy", () => {
    expect(resolveOtpService(baseConfig())).toBeInstanceOf(DummyOtpService);
  });

  it("selects MnotifyOtpService for OTP_PROVIDER=mnotify when mnotify is enabled", () => {
    const service = resolveOtpService(
      baseConfig({ otpProvider: "mnotify", mnotify: { enabled: true, apiKey: "key", senderId: "CampusRide" } }),
    );
    expect(service).toBeInstanceOf(MnotifyOtpService);
  });

  it("falls back to DummyOtpService for OTP_PROVIDER=mnotify when mnotify is not enabled", () => {
    const service = resolveOtpService(baseConfig({ otpProvider: "mnotify" }));
    expect(service).toBeInstanceOf(DummyOtpService);
  });

  it("selects MoolreOtpService for OTP_PROVIDER=moolre when moolre is enabled with vasKey and smsSenderId set", () => {
    const service = resolveOtpService(
      baseConfig({
        otpProvider: "moolre",
        moolre: {
          enabled: true,
          baseUrl: "https://sandbox.moolre.com",
          apiUser: "user",
          vasKey: "vas-key",
          smsSenderId: "CampusRide",
        },
      }),
    );
    expect(service).toBeInstanceOf(MoolreOtpService);
  });

  it("falls back to DummyOtpService for OTP_PROVIDER=moolre when moolre is enabled but vasKey/smsSenderId are missing", () => {
    const service = resolveOtpService(
      baseConfig({ otpProvider: "moolre", moolre: { enabled: true, baseUrl: "https://sandbox.moolre.com", apiUser: "user", vasKey: "", smsSenderId: "" } }),
    );
    expect(service).toBeInstanceOf(DummyOtpService);
  });

  it("falls back to DummyOtpService for OTP_PROVIDER=moolre when moolre is not enabled", () => {
    const service = resolveOtpService(
      baseConfig({
        otpProvider: "moolre",
        moolre: { enabled: false, baseUrl: "https://sandbox.moolre.com", apiUser: "user", vasKey: "vas-key", smsSenderId: "CampusRide" },
      }),
    );
    expect(service).toBeInstanceOf(DummyOtpService);
  });
});
