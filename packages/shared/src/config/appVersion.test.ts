import { describe, expect, it } from "vitest";
import { describeAppVersion, type AppVersionInputs } from "./appVersion";

const BASE: AppVersionInputs = {
  version: "1.0.0",
  updatesEnabled: true,
  isEmbeddedLaunch: false,
  updateId: "3f9c2a1b-7d4e-4c1a-9b0e-5a6f7e8d9c0b",
  createdAt: new Date("2026-10-14T21:30:00Z"),
  channel: "production",
};

describe("describeAppVersion", () => {
  it("names a downloaded update by its short ID, UTC date and channel", () => {
    expect(describeAppVersion(BASE)).toBe(
      "Version 1.0.0 · update 3f9c2a1b · 14 Oct 2026 · production",
    );
  });

  it("uses the UTC date, so it matches the EAS dashboard", () => {
    expect(describeAppVersion({ ...BASE, createdAt: new Date("2026-12-31T23:59:00Z") })).toContain(
      "31 Dec 2026",
    );
  });

  it("says built-in when running the JavaScript that shipped with the store build", () => {
    expect(describeAppVersion({ ...BASE, isEmbeddedLaunch: true })).toBe(
      "Version 1.0.0 · built-in · production",
    );
    expect(describeAppVersion({ ...BASE, updateId: null })).toBe(
      "Version 1.0.0 · built-in · production",
    );
  });

  it("says dev under expo start / Expo Go, where updates are off", () => {
    expect(
      describeAppVersion({ ...BASE, updatesEnabled: false, updateId: null, channel: null }),
    ).toBe("Version 1.0.0 · dev");
  });

  it("copes with missing values", () => {
    expect(
      describeAppVersion({
        ...BASE,
        version: undefined,
        createdAt: new Date("not a date"),
        channel: null,
      }),
    ).toBe("Version ? · update 3f9c2a1b");
  });
});
