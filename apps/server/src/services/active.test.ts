import { describe, it, expect } from "vitest";
import {
  assertOtpServiceAllowedInProduction,
  InsecureOtpProviderError,
  resolveOtpService,
  type OtpProviderConfig,
} from "./active";
import { DummyOtpService } from "./otp/DummyOtpService";
import { MnotifyOtpService } from "./otp/MnotifyOtpService";
import { MoolreOtpService } from "./otp/MoolreOtpService";

function baseConfig(overrides: Partial<OtpProviderConfig> = {}): OtpProviderConfig {
  return {
    otpProvider: "dummy",
    moolre: { smsEnabled: false, baseUrl: "https://sandbox.moolre.com", apiUser: "", vasKey: "", smsSenderId: "" },
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
          smsEnabled: true,
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
      baseConfig({ otpProvider: "moolre", moolre: { smsEnabled: true, baseUrl: "https://sandbox.moolre.com", apiUser: "user", vasKey: "", smsSenderId: "" } }),
    );
    expect(service).toBeInstanceOf(DummyOtpService);
  });

  it("falls back to DummyOtpService for OTP_PROVIDER=moolre when moolre SMS is not enabled", () => {
    const service = resolveOtpService(
      baseConfig({
        otpProvider: "moolre",
        moolre: { smsEnabled: false, baseUrl: "https://sandbox.moolre.com", apiUser: "user", vasKey: "vas-key", smsSenderId: "CampusRide" },
      }),
    );
    expect(service).toBeInstanceOf(DummyOtpService);
  });
});

describe("resolveOtpService — SMS and payments flags are independent", () => {
  it("selects the real SMS provider even though payments stay off (the launch configuration)", () => {
    // The whole point of the Phase 2 split: MOOLRE_SMS_ENABLED=true while
    // MOOLRE_PAYMENTS_ENABLED=false. resolveOtpService must not consult the
    // payments flag at all — OtpProviderConfig does not even carry it.
    const service = resolveOtpService(
      baseConfig({
        otpProvider: "moolre",
        moolre: {
          smsEnabled: true,
          baseUrl: "https://api.moolre.com",
          apiUser: "user",
          vasKey: "vas-key",
          smsSenderId: "CampusRide",
        },
      }),
    );
    expect(service).toBeInstanceOf(MoolreOtpService);
  });
});

describe("assertOtpServiceAllowedInProduction", () => {
  it("refuses to boot with DummyOtpService when NODE_ENV=production", () => {
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "production")).toThrow(
      InsecureOtpProviderError,
    );
  });

  it("names the env vars an operator needs to set", () => {
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "production")).toThrow(
      /OTP_PROVIDER=moolre/,
    );
  });

  it("allows DummyOtpService outside production (dev and test)", () => {
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "development")).not.toThrow();
    expect(() => assertOtpServiceAllowedInProduction(new DummyOtpService(), "test")).not.toThrow();
  });

  it("allows a real provider in production", () => {
    const real = new MoolreOtpService({
      baseUrl: "https://api.moolre.com",
      apiUser: "user",
      vasKey: "vas-key",
      senderId: "CampusRide",
    });
    expect(() => assertOtpServiceAllowedInProduction(real, "production")).not.toThrow();
  });
});
