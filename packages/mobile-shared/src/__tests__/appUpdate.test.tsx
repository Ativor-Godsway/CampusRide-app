import { AppState, BackHandler, Linking, Platform } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { UPDATE_CHECK_TIMEOUT_MS, type AppMinVersions } from "@rida/shared";
import { rawApi } from "../auth/apiClient";
import { AppUpdateGate, checkForRequiredUpdate } from "../appUpdate";

/**
 * The forced update, as the apps run it: the real gate and check against a
 * stand-in for GET /app/min-version. Doubt always lets the person in; a
 * trip in progress is never interrupted.
 */

const installed = { version: "1.0.0" as string | null };
jest.mock("expo-application", () => ({
  get nativeApplicationVersion() {
    return installed.version;
  },
}));

const PLAY = "https://play.google.com/store/apps/details?id=com.campusride.rider";
const unset = { minVersion: null, storeUrl: null };

function minVersions(platform: "ios" | "android", minVersion: string | null, storeUrl: string | null = PLAY): AppMinVersions {
  return {
    rider: { ios: unset, android: unset, [platform]: { minVersion, storeUrl } },
    driver: { ios: unset, android: unset },
  };
}

type Answer = AppMinVersions | "network" | "server-error" | "hang";
let answer: Answer;
let calls = 0;
let appStateListener: ((state: string) => void) | null = null;
const originalAdapter = rawApi.defaults.adapter;

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  calls += 1;
  const current = answer;
  if (current === "hang") return new Promise<AxiosResponse>(() => undefined);
  if (current === "network") throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", config });
  if (current === "server-error") {
    throw Object.assign(new Error("Request failed with status code 503"), {
      config,
      response: { status: 503, data: {}, headers: {}, config, statusText: "" },
    });
  }
  return { data: current, status: 200, statusText: "OK", headers: {}, config };
};

beforeEach(() => {
  jest.useFakeTimers();
  installed.version = "1.0.0";
  answer = minVersions(Platform.OS as "ios", null);
  calls = 0;
  rawApi.defaults.adapter = adapter;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: () => (appStateListener = null) } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  rawApi.defaults.adapter = originalAdapter;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const os = () => Platform.OS as "ios" | "android";

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

async function comeBackToForeground() {
  await act(async () => {
    appStateListener?.("active");
  });
  await settle();
}

describe("checkForRequiredUpdate", () => {
  it("compares the installed native version with this platform's minimum", async () => {
    answer = minVersions(os(), "1.1.0");
    await expect(checkForRequiredUpdate("rider")).resolves.toEqual({
      ok: true,
      requirement: { required: true, storeUrl: PLAY },
    });
    installed.version = "1.1.0";
    await expect(checkForRequiredUpdate("rider")).resolves.toEqual({
      ok: true,
      requirement: { required: false, storeUrl: PLAY },
    });
  });

  it("is not required when the minimum is unset", async () => {
    answer = minVersions(os(), null);
    await expect(checkForRequiredUpdate("rider")).resolves.toMatchObject({ requirement: { required: false } });
  });

  it("fails (open) with no connection, a server error, or no answer in 5 s", async () => {
    answer = "network";
    await expect(checkForRequiredUpdate("rider")).resolves.toEqual({ ok: false });
    answer = "server-error";
    await expect(checkForRequiredUpdate("rider")).resolves.toEqual({ ok: false });

    answer = "hang";
    const pending = checkForRequiredUpdate("rider");
    jest.advanceTimersByTime(UPDATE_CHECK_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ ok: false });
  });
});

describe("AppUpdateGate", () => {
  it("covers the app with one way out: the store", async () => {
    answer = minVersions(os(), "2.0.0");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(<AppUpdateGate app="rider" hold={false} />);
    await settle();

    expect(screen.getByText("Time to update")).toBeTruthy();
    expect(screen.getByText(/Update to keep riding\./)).toBeTruthy();
    await fireEvent.press(screen.getByText("Update now"));
    expect(openURL).toHaveBeenCalledWith(PLAY);
  });

  it("says to search the store when there is no link, and says driving for the driver app", async () => {
    answer = {
      rider: { ios: unset, android: unset },
      driver: { ios: unset, android: unset, [os()]: { minVersion: "2.0.0", storeUrl: null } },
    };
    await render(<AppUpdateGate app="driver" hold={false} />);
    await settle();

    expect(screen.getByText(/Update to keep driving\./)).toBeTruthy();
    expect(screen.getByText("Search CampusRide in your app store")).toBeTruthy();
    expect(screen.queryByText("Update now")).toBeNull();
  });

  it("shows nothing when the version is allowed", async () => {
    answer = minVersions(os(), "1.0.0");
    await render(<AppUpdateGate app="rider" hold={false} />);
    await settle();
    expect(screen.queryByText("Time to update")).toBeNull();
  });

  it("lets the person in when the check fails or never answers", async () => {
    answer = "network";
    const { unmount } = await render(<AppUpdateGate app="rider" hold={false} />);
    await settle();
    expect(screen.queryByText("Time to update")).toBeNull();
    await unmount();

    answer = "hang";
    await render(<AppUpdateGate app="rider" hold={false} />);
    await act(async () => {
      jest.advanceTimersByTime(UPDATE_CHECK_TIMEOUT_MS + 1);
    });
    await settle();
    expect(screen.queryByText("Time to update")).toBeNull();
  });

  it("checks again on every return to the foreground", async () => {
    await render(<AppUpdateGate app="rider" hold={false} />);
    await settle();
    expect(screen.queryByText("Time to update")).toBeNull();

    answer = minVersions(os(), "1.5.0");
    await comeBackToForeground();
    expect(calls).toBe(2);
    expect(screen.getByText("Time to update")).toBeTruthy();

    // A later failed check doesn't take it down; a lowered minimum does.
    answer = "network";
    await comeBackToForeground();
    expect(screen.getByText("Time to update")).toBeTruthy();
    answer = minVersions(os(), null);
    await comeBackToForeground();
    expect(screen.queryByText("Time to update")).toBeNull();
  });

  it("waits for a trip in progress to end, then shows", async () => {
    answer = {
      rider: { ios: unset, android: unset },
      driver: { ios: unset, android: unset, [os()]: { minVersion: "2.0.0", storeUrl: null } },
    };
    const onShow = jest.fn();
    const { rerender } = await render(<AppUpdateGate app="driver" hold onShow={onShow} />);
    await settle();
    expect(screen.queryByText("Time to update")).toBeNull();
    expect(onShow).not.toHaveBeenCalled();

    await rerender(<AppUpdateGate app="driver" hold={false} onShow={onShow} />);
    expect(screen.getByText("Time to update")).toBeTruthy();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("can't be closed with the Android back button", async () => {
    answer = minVersions(os(), "2.0.0");
    const addListener = jest.spyOn(BackHandler, "addEventListener");
    await render(<AppUpdateGate app="rider" hold={false} />);
    await settle();
    const handler = addListener.mock.calls.find(([event]) => event === "hardwareBackPress")?.[1];
    expect((handler as (() => boolean) | undefined)?.()).toBe(true);
  });
});
