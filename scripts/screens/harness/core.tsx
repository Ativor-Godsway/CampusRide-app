/**
 * Runs one scene in the browser: the fake server, the keychain, the phone's
 * position, then the scene's chain of real layouts and screen (see
 * stubs/expo-router.tsx). run.mjs opens index.html#<scene> and waits for
 * window.__screens.ready.
 */
import type { ComponentType } from "react";
import { AppRegistry } from "react-native";
import type { AxiosAdapter, AxiosResponse } from "axios";
import { api, rawApi, type AuthUser } from "@rida/mobile-shared";
import { RouterScene } from "../stubs/expo-router";
import {
  device,
  sceneLocation,
  scenePosition,
  scenePush,
  sceneSocketEvents,
  secureStoreData,
} from "../stubs/expo-modules";

/**
 * "GET /zones" → the response body (or a function of the request body).
 * `refuse(400, "…")` answers with that error instead.
 */
export type Routes = Record<string, unknown | ((body: Record<string, unknown>) => unknown)>;

const REFUSAL = Symbol("refusal");
export function refuse(status: number, error: string) {
  return { [REFUSAL]: true, status, error };
}

/** Done in the browser before the screenshot, in order (run.mjs carries them out). */
export type Step = { press: string } | { type: string; text: string } | { wait: number };

export interface Scene {
  /** File name: <app>-<name>.png. */
  name: string;
  /** Printed beside the file name, e.g. what can't render on the web. */
  note?: string;
  /** Capture the whole scroll length, not just one phone screen. */
  full?: boolean;
  /** Run as a development build (__DEV__). */
  dev?: boolean;
  /** Signed in as this user, or signed out (null). */
  user: AuthUser | null;
  /** The fake server's answers, besides sign-in and /me. */
  routes?: Routes;
  /** Root layout first, the screen last. */
  chain: ComponentType[];
  pathname: string;
  params?: Record<string, string>;
  position?: { latitude: number; longitude: number };
  /** The rider refused location (default: allowed). */
  locationOff?: boolean;
  /** The driver's "all the time" location: not asked yet, or asking fails (default: allowed). */
  locationBackground?: "undetermined" | "fails";
  /** Socket events the screen receives once, by name, e.g. a driver's position. */
  socket?: Record<string, unknown>;
  /** A real phone that hasn't been asked about notifications (default: a simulator, so "unsupported"). */
  pushUndetermined?: boolean;
  /** How long to let it settle before the steps and the screenshot (ms). */
  settleMs?: number;
  /** Taps and typing (by accessibility label, or visible text) before the screenshot. */
  steps?: Step[];
}

declare global {
  interface Window {
    __screens: { list: () => Pick<Scene, "name" | "note" | "full" | "steps">[]; ready: boolean };
  }
}

function installServer(user: AuthUser | null, routes: Routes) {
  const adapter: AxiosAdapter = async (config) => {
    const method = (config.method ?? "get").toUpperCase();
    const path = (config.url ?? "").replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const key = `${method} ${path}`;
    const body =
      typeof config.data === "string" && config.data
        ? JSON.parse(config.data)
        : (config.data ?? {});
    const ok = (data: unknown): AxiosResponse => ({
      status: 200,
      data,
      headers: {},
      config,
      statusText: "OK",
    });

    if (key === "POST /auth/refresh") {
      return user
        ? ok({ accessToken: "access-screens", refreshToken: "refresh-screens" })
        : fail(401);
    }
    if (key === "GET /me" && user) return ok({ user });
    if (key in routes) {
      const raw = routes[key];
      const answer = typeof raw === "function" ? raw(body) : raw;
      if (answer && typeof answer === "object" && REFUSAL in answer) {
        const { status, error } = answer as unknown as { status: number; error: string };
        return fail(status, error);
      }
      return ok(answer);
    }
    console.log(`[screens] no fake answer for ${key} (404)`);
    return fail(404);

    function fail(status: number, error = "screens"): never {
      throw Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        config,
        response: { status, data: { error }, headers: {}, config, statusText: "" },
      });
    }
  };
  api.defaults.adapter = adapter;
  rawApi.defaults.adapter = adapter;
}

export function boot(scenes: Scene[]) {
  window.__screens = {
    list: () => scenes.map(({ name, note, full, steps }) => ({ name, note, full, steps })),
    ready: false,
  };
  const scene = scenes.find((s) => s.name === decodeURIComponent(location.hash.slice(1)));
  if (!scene) return;

  (globalThis as { __DEV__?: boolean }).__DEV__ = Boolean(scene.dev);
  if (scene.position) Object.assign(scenePosition, scene.position);
  sceneLocation.allowed = !scene.locationOff;
  sceneLocation.background = scene.locationBackground ?? "granted";
  Object.assign(sceneSocketEvents, scene.socket ?? {});
  if (scene.pushUndetermined) {
    device.isDevice = true;
    scenePush.status = "undetermined";
  }
  installServer(scene.user, scene.routes ?? {});
  if (scene.user) {
    secureStoreData.set("rida.session.refreshToken", "refresh-screens");
    // The notifications explanation was already shown on this "phone".
    secureStoreData.set("rida.pushPermissionAsked", "1");
  }

  const [Root] = scene.chain;
  function App() {
    return (
      <RouterScene
        scene={{ chain: scene!.chain, params: scene!.params ?? {}, pathname: scene!.pathname }}
      >
        <Root />
      </RouterScene>
    );
  }
  AppRegistry.registerComponent("screens", () => App);
  AppRegistry.runApplication("screens", { rootTag: document.getElementById("root") });
  setTimeout(() => {
    window.__screens.ready = true;
  }, scene.settleMs ?? 2500);
}
