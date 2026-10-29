/// <reference types="node" />
/**
 * The Google Maps API key in an Android build of the rider and driver apps.
 * react-native-maps draws with the Google Maps SDK on Android, and without
 * com.google.android.geo.API_KEY in the manifest the app crashes the moment a
 * map opens (Expo Go has its own key, so only real builds show it). The key
 * comes from the EAS variable GOOGLE_MAPS_ANDROID_API_KEY, never from git
 * (docs/runbooks/google-maps-android.md).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const require = createRequire(__filename);

type Config = { android?: Record<string, unknown> & { config?: Record<string, unknown> } };

describe.each(["rider", "driver"])("the %s app's Android Maps key", (app) => {
  const expo = JSON.parse(read(`apps/${app}/app.json`)).expo;
  const resolve = require(path.join(ROOT, `apps/${app}/app.config.js`)) as (ctx: {
    config: Config;
  }) => Config;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("goes into android.config.googleMaps from GOOGLE_MAPS_ANDROID_API_KEY", () => {
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "test-key");
    const config = resolve({ config: structuredClone(expo) });
    expect(config.android?.config).toEqual({ googleMaps: { apiKey: "test-key" } });
    expect(config.android?.package).toBe(`com.campusride.${app}`);
  });

  it("fails an EAS build that doesn't have it, instead of shipping a crashing app", () => {
    vi.stubEnv("EAS_BUILD", "true");
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "");
    expect(() => resolve({ config: structuredClone(expo) })).toThrow(
      /GOOGLE_MAPS_ANDROID_API_KEY is not set/,
    );
  });

  it("is left out off EAS without it (expo start, Expo Go)", () => {
    vi.stubEnv("GOOGLE_MAPS_ANDROID_API_KEY", "");
    expect(resolve({ config: structuredClone(expo) }).android?.config).toBeUndefined();
  });

  it("is never committed (the repository is public)", () => {
    expect(expo.android.config?.googleMaps).toBeUndefined();
    for (const file of [`apps/${app}/app.json`, `apps/${app}/app.config.js`]) {
      expect(read(file), file).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    }
  });
});
