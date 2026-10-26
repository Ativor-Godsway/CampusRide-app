/// <reference types="node" />
/**
 * What a store build of the rider and driver apps is built with, pinned so a
 * later edit can't ship a dev setup: the EAS profiles, the version, the
 * production server, and no development-only libraries.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const json = (p: string) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));
const PRODUCTION_API = "https://api.campusride.app";

describe.each(["rider", "driver"])("the %s app's store build", (app) => {
  const eas = json(`apps/${app}/eas.json`);
  const expo = json(`apps/${app}/app.json`).expo;
  const pkg = json(`apps/${app}/package.json`);

  it("production: an Android app bundle, remote build numbers counting up, production channel and server", () => {
    expect(eas.cli.appVersionSource).toBe("remote");
    expect(eas.build.production).toMatchObject({
      environment: "production",
      autoIncrement: true,
      channel: "production",
      env: { EXPO_PUBLIC_API_URL: PRODUCTION_API },
      android: { buildType: "app-bundle" },
    });
  });

  it("test builds install directly (APK), and no profile is a development client", () => {
    for (const profile of ["development", "preview"]) {
      expect(eas.build[profile]).toMatchObject({
        distribution: "internal",
        android: { buildType: "apk" },
      });
    }
    for (const profile of Object.values(eas.build) as Array<Record<string, unknown>>) {
      expect(profile.developmentClient).not.toBe(true);
    }
  });

  it("is version 1.0.0, with build numbers left to EAS", () => {
    expect(expo.version).toBe("1.0.0");
    expect(expo.android?.versionCode).toBeUndefined();
    expect(expo.ios?.buildNumber).toBeUndefined();
    expect(expo.extra?.SERVER_URL).toBe(PRODUCTION_API);
  });

  it("ships no development-only library", () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const name of [
      "expo-dev-client",
      "expo-dev-menu",
      "react-native-flipper",
      "reactotron-react-native",
    ]) {
      expect(deps[name], name).toBeUndefined();
    }
  });
});

/** Width, height and colour type from a PNG's header (colour type 2 = RGB, no alpha). */
function pngHeader(p: string): { width: number; height: number; colourType: number } {
  const bytes = readFileSync(path.join(ROOT, p));
  expect(bytes.subarray(12, 16).toString("latin1"), p).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), colourType: bytes[25]! };
}

/** Each app's icon and splash background (also baked into icon.png by the script). */
const BACKGROUNDS: Record<string, string> = { rider: "#19743C", driver: "#0F1311" };

describe("the app icons and splash (made by scripts/brand/generate.py: docs/runbooks/releasing.md)", () => {
  it.each(["rider", "driver"])("%s: 1024 x 1024, and the iOS icon has no transparency", (app) => {
    const expo = json(`apps/${app}/app.json`).expo;
    const icon = pngHeader(path.join("apps", app, expo.icon));
    expect(icon).toEqual({ width: 1024, height: 1024, colourType: 2 });
    const adaptive = pngHeader(path.join("apps", app, expo.android.adaptiveIcon.foregroundImage));
    expect([adaptive.width, adaptive.height]).toEqual([1024, 1024]);
  });

  it.each(["rider", "driver"])(
    "%s: the adaptive icon and splash sit on the app's colour, light and dark",
    (app) => {
      const expo = json(`apps/${app}/app.json`).expo;
      const colour = BACKGROUNDS[app];
      expect(expo.android.adaptiveIcon.backgroundColor).toBe(colour);
      const splash = (expo.plugins as unknown[]).find(
        (p): p is [string, Record<string, any>] =>
          Array.isArray(p) && p[0] === "expo-splash-screen",
      )![1];
      expect(splash.backgroundColor).toBe(colour);
      expect(splash.dark.backgroundColor).toBe(colour);
      expect(splash.android.dark.backgroundColor).toBe(colour);
      // Android 12+ masks the splash to a 192 dp circle: the logo with its
      // name only fits inside it up to about 170 dp wide.
      expect(splash.android.imageWidth).toBeLessThanOrEqual(170);
      expect(pngHeader(path.join("apps", app, splash.image)).width).toBe(1024);
    },
  );

  it.each(["rider", "driver"])("%s: a 512 x 512 Play Store icon with no transparency", (app) => {
    expect(pngHeader(`store-assets/${app}/play-icon-512.png`)).toEqual({
      width: 512,
      height: 512,
      colourType: 2,
    });
  });

  it("the rider and driver apps have different icons", () => {
    const rider = readFileSync(path.join(ROOT, "apps/rider/assets/icon.png"));
    const driver = readFileSync(path.join(ROOT, "apps/driver/assets/icon.png"));
    // The adaptive foregrounds are the same white mark; the background
    // colours checked above tell them apart.
    expect(rider.equals(driver)).toBe(false);
  });
});
