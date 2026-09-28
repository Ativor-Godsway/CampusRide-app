import { describe, it, expect, vi } from "vitest";
import {
  checkCloudinaryAtStartup,
  missingCloudinaryVars,
  resolveCloudinaryConfig,
} from "./cloudinaryConfig";

const FULL = { cloudName: "campusride", apiKey: "123456789012345", apiSecret: "shh-secret" };

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("resolveCloudinaryConfig", () => {
  it("reads the three CLOUDINARY_* vars under exactly those names", () => {
    const cfg = resolveCloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: "campusride",
      CLOUDINARY_API_KEY: "123456789012345",
      CLOUDINARY_API_SECRET: "shh-secret",
    });
    expect(cfg).toEqual(FULL);
  });

  it("trims whitespace pasted into a dashboard, which would otherwise break every signature", () => {
    const cfg = resolveCloudinaryConfig({
      CLOUDINARY_CLOUD_NAME: " campusride ",
      CLOUDINARY_API_KEY: "123456789012345\n",
      CLOUDINARY_API_SECRET: "  shh-secret\n",
    });
    expect(cfg).toEqual(FULL);
  });

  it("falls back to CLOUDINARY_URL when the separate vars are absent", () => {
    const cfg = resolveCloudinaryConfig({
      CLOUDINARY_URL: "cloudinary://123456789012345:shh-secret@campusride",
    });
    expect(cfg).toEqual(FULL);
  });

  it("lets an explicitly set separate var win over CLOUDINARY_URL", () => {
    const cfg = resolveCloudinaryConfig({
      CLOUDINARY_URL: "cloudinary://123456789012345:shh-secret@campusride",
      CLOUDINARY_CLOUD_NAME: "other-cloud",
      CLOUDINARY_API_SECRET: "",
    });
    expect(cfg.cloudName).toBe("other-cloud");
    // Blank is treated as unset, so the URL still supplies the secret.
    expect(cfg.apiSecret).toBe("shh-secret");
  });

  it("ignores a malformed CLOUDINARY_URL", () => {
    expect(resolveCloudinaryConfig({ CLOUDINARY_URL: "not-a-url" })).toEqual({
      cloudName: "",
      apiKey: "",
      apiSecret: "",
    });
  });
});

describe("missingCloudinaryVars", () => {
  it("names every missing var, so the log line says exactly what to set", () => {
    expect(missingCloudinaryVars({ cloudName: "c", apiKey: "", apiSecret: "" })).toEqual([
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ]);
    expect(missingCloudinaryVars(FULL)).toEqual([]);
  });
});

describe("checkCloudinaryAtStartup", () => {
  it("warns with the missing var names and makes no network call", async () => {
    const log = fakeLog();
    const fetchImpl = vi.fn();
    await checkCloudinaryAtStartup({ ...FULL, apiSecret: "" }, log, fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, missing: ["CLOUDINARY_API_SECRET"] }),
      expect.stringContaining("CLOUDINARY_API_SECRET"),
    );
  });

  it("logs success when Cloudinary accepts the credentials", async () => {
    const log = fakeLog();
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await checkCloudinaryAtStartup(FULL, log, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.cloudinary.com/v1_1/campusride/ping",
      expect.anything(),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
      expect.any(String),
    );
  });

  it("logs Cloudinary's rejection without ever logging the secret", async () => {
    const log = fakeLog();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Invalid api_key 123456789012345" } }), {
        status: 401,
      }),
    );
    await checkCloudinaryAtStartup(FULL, log, fetchImpl);

    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        status: 401,
        cloudinaryMessage: "Invalid api_key 123456789012345",
      }),
      expect.stringContaining("REJECTED"),
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(FULL.apiSecret);
  });

  it("never throws when Cloudinary is unreachable", async () => {
    const log = fakeLog();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    await expect(checkCloudinaryAtStartup(FULL, log, fetchImpl)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
