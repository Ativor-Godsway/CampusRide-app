/// <reference types="node" />
/**
 * What the app stores check about location, pinned so a later change can't
 * quietly break it (Google Play background location / foreground service
 * policy, Apple review). Reads the apps' config and source directly.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

function locationPlugin(app: "rider" | "driver"): Record<string, unknown> {
  const plugins = JSON.parse(read(`apps/${app}/app.json`)).expo.plugins as unknown[];
  const entry = plugins.find((p) => Array.isArray(p) && p[0] === "expo-location") as [
    string,
    Record<string, unknown>,
  ];
  return entry[1];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    if (name === "node_modules" || name.startsWith(".") || name === "dist") continue;
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(rel);
  }
  return out;
}

const BACKGROUND_APIS =
  /requestBackgroundPermissionsAsync|startLocationUpdatesAsync|expo-task-manager|ACCESS_BACKGROUND_LOCATION/;

describe("the rider app uses location only while it's open", () => {
  it("asks for no background location, and declares no 'Always' purpose or background mode", () => {
    const opts = locationPlugin("rider");
    expect(opts.isAndroidBackgroundLocationEnabled).not.toBe(true);
    expect(opts.isAndroidForegroundServiceEnabled).not.toBe(true);
    expect(opts.isIosBackgroundLocationEnabled).not.toBe(true);
    expect(opts.locationAlwaysAndWhenInUsePermission).toBe(false);
    expect(opts.locationAlwaysPermission).toBe(false);
    expect(typeof opts.locationWhenInUsePermission).toBe("string");
    expect(
      JSON.parse(read("apps/rider/package.json")).dependencies["expo-task-manager"],
    ).toBeUndefined();
  });

  it("never calls a background location API, in its own code or the shared code", () => {
    const offenders = [
      ...sourceFiles("apps/rider"),
      ...sourceFiles("packages/mobile-shared/src"),
    ].filter((f) => BACKGROUND_APIS.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

describe("the driver app's background location", () => {
  it("is declared for Android (background + foreground service) and iOS (background mode)", () => {
    const opts = locationPlugin("driver");
    expect(opts).toMatchObject({
      isAndroidBackgroundLocationEnabled: true,
      isAndroidForegroundServiceEnabled: true,
      isIosBackgroundLocationEnabled: true,
    });
  });

  it("has purpose strings that say what location is for, and when", () => {
    const opts = locationPlugin("driver");
    for (const key of ["locationAlwaysAndWhenInUsePermission", "locationAlwaysPermission"]) {
      expect(opts[key]).toContain("while you are online");
      expect(opts[key]).toContain("even when the app is closed or not in use");
      expect(opts[key]).toContain("stops when you go offline");
    }
    expect(opts.locationWhenInUsePermission).toContain("match you with nearby ride requests");
  });

  it("asks for location only when going online, never at start-up", () => {
    // Called, or handed to resolveGoOnlineAccess: either way, only the go-online flow.
    const callers = sourceFiles("apps/driver").filter((f) =>
      /\brequestDriverLocationAccess\b/.test(read(f)),
    );
    expect(callers.sort()).toEqual([
      "apps/driver/lib/backgroundLocation.ts",
      "apps/driver/lib/presence.tsx",
    ]);
    const directPrompts = sourceFiles("apps/driver").filter(
      (f) =>
        f !== "apps/driver/lib/backgroundLocation.ts" &&
        /request(Foreground|Background)PermissionsAsync/.test(read(f)),
    );
    expect(directPrompts).toEqual([]);
  });

  it("drops the unused iOS 'fetch' background mode that expo-task-manager adds", () => {
    expect(read("apps/driver/app.config.js")).toContain("withoutBackgroundFetch");
  });
});

describe("the driver app defines its location task before anything can use it", () => {
  // Sentry CAMPUSRIDE-DRIVER-1: a task the OS asks for before JavaScript has
  // defined it. iOS and Android both build the bundle from package.json
  // "main" (no entryPoint override), so index.ts runs first on both.
  it("the entry is index.ts, which loads the task's module before expo-router", () => {
    expect(JSON.parse(read("apps/driver/package.json")).main).toBe("index.ts");
    expect(JSON.parse(read("apps/driver/app.json")).expo.entryPoint).toBeUndefined();
    expect(read("apps/driver/app.config.js")).not.toMatch(/entryPoint/);
    const imports = [...read("apps/driver/index.ts").matchAll(/^import\s+"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).toEqual(["./lib/backgroundLocation", "expo-router/entry"]);
  });

  it("defines the task at the top level of that module, and checks it before starting", () => {
    const source = read("apps/driver/lib/backgroundLocation.ts");
    expect(source).toMatch(/^TaskManager\.defineTask\(DRIVER_LOCATION_TASK,/m);
    expect(source).toMatch(/TaskManager\.isTaskDefined\(DRIVER_LOCATION_TASK\)/);
    // Only this module starts or stops updates.
    const users = sourceFiles("apps/driver")
      .filter((f) => /startLocationUpdatesAsync|stopLocationUpdatesAsync/.test(read(f)))
      .map((f) => f.split(path.sep).join("/"));
    expect(users).toEqual(["apps/driver/lib/backgroundLocation.ts"]);
  });
});

describe("the driver's position reaches the server while the app is in the background", () => {
  // Android pauses JS timers in the background and with the screen locked:
  // a timer-only sender stopped there, and riders lost the car on a trip.
  it("every background fix goes straight to the sender, and only the sender emits positions", () => {
    const sender = read("apps/driver/lib/positionSender.ts");
    expect(sender).toMatch(/^onDriverLocation\(\(sample\) => offerPosition\(sample\)\);$/m);
    const emitters = sourceFiles("apps/driver")
      .filter((f) => /DRIVER_CLIENT_EVENTS\.(LOCATION_UPDATE|POSITION_UPDATE)/.test(read(f)))
      .map((f) => f.split(path.sep).join("/"));
    expect(emitters).toEqual(["apps/driver/lib/positionSender.ts"]);
  });

  it("the location task takes its cadence from driverLocationCadence (Android: fixes without moving)", () => {
    const source = read("apps/driver/lib/backgroundLocation.ts");
    expect(source).toContain("...driverLocationCadence(Platform.OS, mode)");
    expect(source).not.toMatch(/distanceInterval:\s*10/);
  });
});
