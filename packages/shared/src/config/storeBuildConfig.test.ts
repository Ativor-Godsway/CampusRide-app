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
