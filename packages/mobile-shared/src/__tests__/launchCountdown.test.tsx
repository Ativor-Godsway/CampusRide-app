import { Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { opensInText } from "@rida/shared";
import { api, rawApi } from "../auth/apiClient";
import { useLaunchView } from "../launch";

/**
 * The launch countdown as the apps run it: the real hook against a stand-in
 * for GET /launch-status and /me/launch-status. It counts down on the
 * server's clock whatever the phone's clock says, and ends at the launch
 * moment by itself.
 */

const signedIn = { as: null as null | "RIDER" | "DRIVER" };
jest.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    isAuthenticated: signedIn.as !== null,
    user: signedIn.as ? { role: signedIn.as } : null,
  }),
}));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The real time. The phone's clock is this plus `phoneClockError`. */
const SERVER_START = Date.parse("2026-11-14T07:00:00.000Z");
const LAUNCH = Date.parse("2026-11-14T09:00:00.000Z");
let phoneClockError = 0;
let failing = false;
let canRide: boolean | undefined;
const paths: string[] = [];
const originals = { raw: rawApi.defaults.adapter, api: api.defaults.adapter };

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  paths.push(config.url ?? "");
  if (failing) throw Object.assign(new Error("Network Error"), { code: "ERR_NETWORK", config });
  const serverNow = Date.now() - phoneClockError;
  const data = {
    mode: serverNow < LAUNCH ? "COUNTDOWN" : "LIVE",
    launchAt: serverNow < LAUNCH ? new Date(LAUNCH).toISOString() : null,
    serverTime: new Date(serverNow).toISOString(),
    ...(config.url === "/me/launch-status" && canRide !== undefined ? { canRide } : {}),
  };
  return { data, status: 200, statusText: "OK", headers: {}, config };
};

function Probe() {
  const view = useLaunchView();
  return <Text>{view.kind === "countdown" ? opensInText(view.parts) : "open"}</Text>;
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    jest.advanceTimersByTime(0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Moves the clock on a second at a time, letting each re-render schedule the next tick (as on a phone). */
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(1_000, left));
    });
    await settle();
  }
}

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  await settle();
}

beforeEach(() => {
  jest.useFakeTimers();
  phoneClockError = 0;
  failing = false;
  canRide = undefined;
  signedIn.as = null;
  paths.length = 0;
  rawApi.defaults.adapter = adapter;
  api.defaults.adapter = adapter;
});

afterEach(() => {
  rawApi.defaults.adapter = originals.raw;
  api.defaults.adapter = originals.api;
  jest.useRealTimers();
});

it("counts down on the server's clock when the phone's clock is a day fast", async () => {
  phoneClockError = DAY;
  jest.setSystemTime(SERVER_START + phoneClockError);
  await show();
  expect(screen.getByText("Opens in 2h 0m")).toBeTruthy();

  // The display moves on just after each minute (20 ms margin).
  await advance(25 * MINUTE + 50);
  expect(screen.getByText("Opens in 1h 35m")).toBeTruthy();
});

it("and when it's days slow", async () => {
  phoneClockError = -3 * DAY;
  jest.setSystemTime(SERVER_START + phoneClockError);
  await show();
  expect(screen.getByText("Opens in 2h 0m")).toBeTruthy();
});

it("goes away by itself at the launch moment, with no app restart", async () => {
  jest.setSystemTime(LAUNCH - 90_000);
  await show();
  expect(screen.getByText("Opens in 2 min")).toBeTruthy();

  failing = true; // No help from the server: it's the clock that opens it.
  await advance(60_000);
  expect(screen.getByText("Opens in 1 min")).toBeTruthy();
  await advance(29_000);
  expect(screen.getByText("Opens in 1 min")).toBeTruthy();
  await advance(1_050);
  expect(screen.getByText("open")).toBeTruthy();
});

it("shows an early-access rider no countdown (from the signed-in status)", async () => {
  signedIn.as = "RIDER";
  canRide = true;
  jest.setSystemTime(SERVER_START);
  await show();
  expect(paths).toContain("/me/launch-status");
  expect(screen.getByText("open")).toBeTruthy();
});

it("shows a rider without early access the countdown", async () => {
  signedIn.as = "RIDER";
  canRide = false;
  jest.setSystemTime(SERVER_START);
  await show();
  expect(screen.getByText("Opens in 2h 0m")).toBeTruthy();
});

it("drivers use the public status", async () => {
  signedIn.as = "DRIVER";
  jest.setSystemTime(SERVER_START);
  await show();
  expect(paths).toEqual(["/launch-status"]);
  expect(screen.getByText("Opens in 2h 0m")).toBeTruthy();
});

it("shows no countdown when the status can't be fetched", async () => {
  failing = true;
  jest.setSystemTime(SERVER_START);
  await show();
  expect(screen.getByText("open")).toBeTruthy();
});
