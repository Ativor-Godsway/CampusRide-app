/// <reference types="node" />
/**
 * What App Store Connect and App Review check in an iOS build of the rider
 * and driver apps, pinned so a later edit can't quietly break it: the bundle
 * ids, the export-compliance answer, the privacy manifest
 * (PrivacyInfo.xcprivacy, written from `ios.privacyManifests`), and purpose
 * strings that say what each permission is for instead of a library's
 * "Allow $(PRODUCT_NAME) to …" placeholder. Background location itself is in
 * appLocationConfig.test.ts.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(read(p));

type Apps = "rider" | "driver";
type ApiType = { NSPrivacyAccessedAPIType: string; NSPrivacyAccessedAPITypeReasons: string[] };
type DataType = {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked: boolean;
  NSPrivacyCollectedDataTypeTracking: boolean;
  NSPrivacyCollectedDataTypePurposes: string[];
};

const expoConfig = (app: Apps) => json(`apps/${app}/app.json`).expo;

function pluginOptions(app: Apps, name: string): Record<string, unknown> | undefined {
  const entry = (expoConfig(app).plugins as unknown[]).find(
    (p) => p === name || (Array.isArray(p) && p[0] === name),
  );
  if (entry === undefined) return undefined;
  return Array.isArray(entry) ? (entry[1] as Record<string, unknown>) : {};
}

function privacyFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "node_modules" || name === "example") continue;
    if (statSync(full).isDirectory()) out.push(...privacyFiles(full));
    else if (name === "PrivacyInfo.xcprivacy") out.push(full);
  }
  return out;
}

/** "Required reason" APIs a library's own PrivacyInfo.xcprivacy declares (XML plist). */
function declaredApis(file: string): Map<string, string[]> {
  const xml = readFileSync(file, "utf8");
  const apis = new Map<string, string[]>();
  // Innermost <dict> blocks holding an API type: one per category.
  for (const [block] of xml.matchAll(/<dict>(?:(?!<dict>)[\s\S])*?<\/dict>/g)) {
    const type = /<key>NSPrivacyAccessedAPIType<\/key>\s*<string>([^<]+)<\/string>/.exec(block);
    const reasons = /<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      block,
    );
    if (!type?.[1] || !reasons?.[1]) continue;
    apis.set(
      type[1],
      [...reasons[1].matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]!),
    );
  }
  return apis;
}

/**
 * Privacy manifests of the native libraries in an app's build. Not included:
 * react-native-maps' Google Maps bundle (iOS uses Apple Maps; the Google Maps
 * SDK isn't installed) and Sentry's (its iOS SDK is downloaded by CocoaPods;
 * it declares UserDefaults CA92.1, SystemBootTime 35F9.1, FileTimestamp
 * C617.1, all already in the app's manifest).
 */
function libraryManifests(app: Apps): string[] {
  const deps = Object.keys(json(`apps/${app}/package.json`).dependencies);
  const files: string[] = [];
  for (const dep of [...deps, "react-native", "expo-eas-client"]) {
    for (const base of [`apps/${app}/node_modules/${dep}`, `node_modules/${dep}`]) {
      const dir = path.join(ROOT, base);
      if (!existsSync(dir)) continue;
      files.push(...privacyFiles(dir).filter((f) => !f.includes("AirGoogleMaps")));
      break;
    }
  }
  return files;
}

describe.each<Apps>(["rider", "driver"])("the %s app's iOS build", (app) => {
  const expo = expoConfig(app);
  const manifest = expo.ios?.privacyManifests;

  it("has its store bundle id and answers export compliance (no non-exempt encryption)", () => {
    expect(expo.ios.bundleIdentifier).toBe(`com.campusride.${app}`);
    expect(expo.ios.config?.usesNonExemptEncryption).toBe(false);
  });

  it("declares no tracking in its privacy manifest", () => {
    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    for (const type of manifest.NSPrivacyCollectedDataTypes as DataType[]) {
      expect(type.NSPrivacyCollectedDataTypeTracking, type.NSPrivacyCollectedDataType).toBe(false);
      expect(type.NSPrivacyCollectedDataTypePurposes.length).toBeGreaterThan(0);
    }
  });

  it("declares every required-reason API its libraries declare", () => {
    const ours = new Map(
      (manifest.NSPrivacyAccessedAPITypes as ApiType[]).map((t) => [
        t.NSPrivacyAccessedAPIType,
        t.NSPrivacyAccessedAPITypeReasons,
      ]),
    );
    const files = libraryManifests(app);
    expect(files.length).toBeGreaterThan(5);
    const missing: string[] = [];
    for (const file of files) {
      for (const [type, reasons] of declaredApis(file)) {
        for (const reason of reasons) {
          if (!ours.get(type)?.includes(reason))
            missing.push(`${type} ${reason} (${path.relative(ROOT, file)})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("declares the personal data it collects (docs/store/data-inventory.md)", () => {
    const collected = (manifest.NSPrivacyCollectedDataTypes as DataType[]).map((t) =>
      t.NSPrivacyCollectedDataType.replace("NSPrivacyCollectedDataType", ""),
    );
    expect(collected).toEqual(
      expect.arrayContaining([
        "Name",
        "PhoneNumber",
        "PreciseLocation",
        "UserID",
        "DeviceID",
        "CrashData",
      ]),
    );
    if (app === "driver") expect(collected).toContain("PhotosorVideos");
    else expect(collected).not.toContain("PhotosorVideos");
  });

  it("replaces every library's placeholder purpose string with its own", () => {
    expect(pluginOptions(app, "expo-secure-store")?.faceIDPermission).toEqual(expect.any(String));
    expect(pluginOptions(app, "expo-location")?.motionUsagePermission).toEqual(expect.any(String));
    if (app === "driver")
      expect(pluginOptions(app, "expo-image-picker")).toMatchObject({
        photosPermission: expect.stringContaining("profile photo"),
        cameraPermission: expect.stringContaining("profile photo"),
        microphonePermission: expect.any(String),
      });
    const strings = JSON.stringify(expo.plugins);
    expect(strings).not.toContain("$(PRODUCT_NAME)");
    expect(strings).not.toMatch(/"Allow /);
  });

  it("asks for no remote-notification background mode (pushes are visible alerts only)", () => {
    expect(pluginOptions(app, "expo-notifications")?.enableBackgroundRemoteNotifications).not.toBe(
      true,
    );
    expect(JSON.stringify(expo.ios.infoPlist ?? {})).not.toContain("remote-notification");
  });
});
