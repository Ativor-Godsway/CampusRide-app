import { AppState, Text } from "react-native";
import { act, renderRouter, screen } from "expo-router/testing-library";
import { router } from "expo-router";
import { NEARBY_CARS_POLL_MS, type NearbyCar } from "@rida/shared";
import { useNearbyCars } from "../maps/nearbyCars";
import { setAccessToken } from "../auth/tokenStore";
import { installFakeServer, type FakeServer } from "./fakeServer";

/**
 * The cars on the rider's Home map are asked for every 10 s only while Home
 * is on screen, the app is open and the rider has no ride going on; never
 * otherwise. No cars, or a failed ask, is an empty map — never an error.
 */

let server: FakeServer;
let appStateListener: ((state: string) => void) | null = null;
let answer: { cars: unknown };

const CAR: NearbyCar = { key: "k1", latitude: 5.652, longitude: -0.187, heading: 90 };

beforeEach(() => {
  jest.useFakeTimers();
  server = installFakeServer("RIDER");
  setAccessToken(server.issue().accessToken);
  answer = { cars: [CAR] };
  server.routes["GET /rides/nearby-cars"] = () => answer;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: () => (appStateListener = null) } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const asks = () => server.calls.filter((c) => c === "GET /rides/nearby-cars").length;

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function home(enabled: boolean) {
  return function Home() {
    const cars = useNearbyCars(enabled, { latitude: 5.65, longitude: -0.187 });
    return <Text testID="cars">{cars.map((c) => c.key).join(",") || "none"}</Text>;
  };
}

const shown = () => screen.getByTestId("cars").props.children as string;

describe("asking for the cars on Home", () => {
  it("asks at once and every 10 s while Home is on screen", async () => {
    await renderRouter({ index: home(true) }, { initialUrl: "/" });
    await wait(0);
    expect(asks()).toBe(1);
    expect(shown()).toBe("k1");
    await wait(NEARBY_CARS_POLL_MS * 3);
    expect(asks()).toBe(4);
  });

  it("stops in the background and asks again on coming back", async () => {
    await renderRouter({ index: home(true) }, { initialUrl: "/" });
    await wait(0);
    await act(async () => appStateListener?.("background"));
    expect(shown()).toBe("none");
    await wait(NEARBY_CARS_POLL_MS * 5);
    expect(asks()).toBe(1);
    await act(async () => appStateListener?.("active"));
    await wait(0);
    expect(asks()).toBe(2);
    expect(shown()).toBe("k1");
  });

  it("stops while another screen is on top of Home", async () => {
    await renderRouter({ index: home(true), other: () => <Text>Other</Text> }, { initialUrl: "/" });
    await wait(0);
    await act(async () => router.push("/other"));
    await wait(NEARBY_CARS_POLL_MS * 5);
    expect(asks()).toBe(1);
  });

  it("never asks with a ride going on (the caller turns it off)", async () => {
    await renderRouter({ index: home(false) }, { initialUrl: "/" });
    await wait(NEARBY_CARS_POLL_MS * 3);
    expect(asks()).toBe(0);
    expect(shown()).toBe("none");
  });

  it("no cars, junk, or a failed ask: nothing shown, no error", async () => {
    answer = { cars: [{ key: 5 }, { key: "x", latitude: "5", longitude: 0, heading: null }, null] };
    await renderRouter({ index: home(true) }, { initialUrl: "/" });
    await wait(0);
    expect(shown()).toBe("none");
    server.outage = "server-error";
    await wait(NEARBY_CARS_POLL_MS);
    expect(shown()).toBe("none");
  });
});
