/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as SecureStore from "expo-secure-store";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import {
  mapsLoadingAtLastStop,
  paddingWhenReady,
  resetMapLaunchGuardForTests,
  useMapLaunchGuard,
} from "../maps/mapSafety";

const KEY = "campusride.maps-loading";

beforeEach(async () => {
  resetMapLaunchGuardForTests();
  await SecureStore.deleteItemAsync(KEY);
});

/** Lets the guard's queued SecureStore writes finish. */
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe("paddingWhenReady", () => {
  it("gives no padding before onMapReady (Android would crash), the padding after", () => {
    const padding = { top: 40, right: 0, bottom: 200, left: 0 };
    expect(paddingWhenReady(false, padding)).toBeUndefined();
    expect(paddingWhenReady(true, padding)).toBe(padding);
  });
});

describe("useMapLaunchGuard", () => {
  it("shows the map on a normal launch, and forgets it once it's ready", async () => {
    const { result } = await renderHook(() => useMapLaunchGuard("driver-trip"));
    await waitFor(() => expect(result.current.showMap).toBe(true));
    await settle();
    expect(JSON.parse((await SecureStore.getItemAsync(KEY))!)).toEqual(["driver-trip"]);

    await act(async () => result.current.onMapReady());
    await settle();
    expect(await SecureStore.getItemAsync(KEY)).toBeNull();
  });

  it("after the app stopped while that map was loading, opens without it until asked", async () => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(["driver-trip"]));
    const { result } = await renderHook(() => useMapLaunchGuard("driver-trip"));
    await waitFor(() => expect(result.current.showMap).toBe(false));

    await act(async () => result.current.showAnyway());
    expect(result.current.showMap).toBe(true);
  });

  it("only holds back the map that was loading", async () => {
    await SecureStore.setItemAsync(KEY, JSON.stringify(["driver-trip"]));
    const { result } = await renderHook(() => useMapLaunchGuard("rider-home"));
    await waitFor(() => expect(result.current.showMap).toBe(true));
  });

  it("closing the screen before the map is ready isn't counted as a crash", async () => {
    const { result, unmount } = await renderHook(() => useMapLaunchGuard("driver-trip"));
    await waitFor(() => expect(result.current.showMap).toBe(true));
    unmount();
    await settle();
    expect(await SecureStore.getItemAsync(KEY)).toBeNull();
  });

  it("reads a damaged value as nothing loading", async () => {
    await SecureStore.setItemAsync(KEY, "{not json");
    expect([...(await mapsLoadingAtLastStop())]).toEqual([]);
  });
});

/** Every .tsx under a folder, skipping dependencies and builds. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name: string) => {
    if (["node_modules", "dist", ".expo", "__tests__"].includes(name)) return [];
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return full.endsWith(".tsx") ? [full] : [];
  });
}

describe("every MapView in the apps", () => {
  it("passes mapPadding through paddingWhenReady (react-native-maps 1.27 crashes otherwise)", () => {
    const root = path.resolve(__dirname, "../../../..");
    const files = ["apps/rider", "apps/driver", "packages/mobile-shared/src"].flatMap((d) => sources(path.join(root, d)));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/mapPadding=\{(?!paddingWhenReady\()/g)].map(
        () => path.relative(root, file),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
