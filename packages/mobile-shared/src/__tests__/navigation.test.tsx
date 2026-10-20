import { act, fireEvent, screen, waitFor } from "expo-router/testing-library";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";
import { getMe } from "../auth/api";
import { installFakeServer, type FakeServer } from "./fakeServer";
import {
  enterPhoneAndCode,
  freshLaunch,
  history,
  onDisk,
  pathname,
  renderApp,
  signInThroughScreens,
  storeRefreshToken,
} from "./routes";

/**
 * Every way around the apps keeps a signed-in person signed in — and on the
 * screen they meant to reach. Run against the real expo-router.
 *
 * The bug these guard against: after signing in, the phone-number screen
 * stayed at the bottom of the navigation history, and "Back to Home" (which
 * returned to the bottom of the history) showed it. The rider after a trip
 * and the driver tapping ← mid-trip both looked signed out.
 */

let server: FakeServer;

beforeEach(async () => {
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  await freshLaunch();
  server = installFakeServer("RIDER");
});

async function launchSignedIn(app: "rider" | "driver", initialUrl = "/") {
  server = installFakeServer(app === "rider" ? "RIDER" : "DRIVER");
  await storeRefreshToken(server.issue().refreshToken);
  await renderApp(app, initialUrl);
}

async function signInFresh(app: "rider" | "driver") {
  server = installFakeServer(app === "rider" ? "RIDER" : "DRIVER");
  await renderApp(app);
  await signInThroughScreens(fireEvent);
}

describe("signing in", () => {
  it.each(["rider", "driver"] as const)("%s: leaves no sign-in screen in the history", async (app) => {
    await signInFresh(app);
    expect(history()).toEqual(["(tabs)"]);
    expect(pathname()).toBe("/");
    expect(router.canGoBack()).toBe(false);
  });

  it("a new number: the same way in, then the name step, and no sign-in screen left in the history", async () => {
    server.registered = false;
    await renderApp("rider");
    await enterPhoneAndCode(fireEvent);
    await fireEvent.changeText(await screen.findByLabelText("Your name"), "Ama Test");
    // Continue stays off, and says why, until the box is ticked.
    expect(screen.getByText("Tick the box to continue.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole("checkbox"));
    await fireEvent.press(screen.getByText("Continue"));
    await screen.findByText("Home screen");
    expect(history()).toEqual(["(tabs)"]);
    expect(server.calls).toContain("POST /auth/signup");
  });

  it("a signed-in person sent to the sign-in screen is brought straight back", async () => {
    await launchSignedIn("rider");
    await screen.findByText("Home screen");
    await act(() => router.push("/auth/phone"));
    await screen.findByText("Home screen");
    expect(pathname()).toBe("/");
    expect(await onDisk()).not.toBeNull();
  });
});

describe("rider: Back to Home after a trip", () => {
  it("right after signing in: goes Home, still signed in", async () => {
    await signInFresh("rider");
    await fireEvent.press(screen.getByText("Open rider trip"));
    await fireEvent.press(await screen.findByText("Back to home"));
    await screen.findByText("Home screen");
    expect(pathname()).toBe("/");
    expect(history()).toEqual(["(tabs)"]);
    expect(await onDisk()).not.toBeNull();
  });

  it("when the app was opened already signed in", async () => {
    await launchSignedIn("rider");
    await fireEvent.press(await screen.findByText("Open rider trip"));
    await fireEvent.press(await screen.findByText("Back to home"));
    await screen.findByText("Home screen");
    expect(pathname()).toBe("/");
  });

  it("from a trip opened from Rides (history)", async () => {
    await launchSignedIn("rider");
    await screen.findByText("Home screen");
    await act(() => router.navigate("/rides"));
    await fireEvent.press(await screen.findByText("Open past rider trip"));
    await fireEvent.press(await screen.findByText("Back to home"));
    await waitFor(() => expect(history()).toEqual(["(tabs)"]));
    expect(screen.queryByText("Continue with phone number")).toBeNull();
  });

  it("the trip's back arrow returns to the screen before it", async () => {
    await signInFresh("rider");
    await fireEvent.press(screen.getByText("Open rider trip"));
    await fireEvent.press(await screen.findByText("Back arrow"));
    await screen.findByText("Home screen");
    expect(history()).toEqual(["(tabs)"]);
  });

  it("a trip opened on its own (app relaunched mid-ride): Home replaces it", async () => {
    await launchSignedIn("rider", "/ride/type");
    await fireEvent.press(await screen.findByText("Back to home"));
    await screen.findByText("Home screen");
    expect(pathname()).toBe("/");
    expect(history()).toEqual(["(tabs)"]);
  });
});

describe("driver: ← during a trip", () => {
  it("right after signing in: goes Home, still signed in", async () => {
    await signInFresh("driver");
    await fireEvent.press(screen.getByText("Open driver trip"));
    await fireEvent.press(await screen.findByText("←"));
    await screen.findByText("Home screen");
    expect(pathname()).toBe("/");
    expect(history()).toEqual(["(tabs)"]);
    expect(await onDisk()).not.toBeNull();
  });

  it("Android's back button on Home after signing in can't reach the sign-in screen", async () => {
    await signInFresh("driver");
    expect(router.canGoBack()).toBe(false);
  });

  it("the trip opened from a notification on a cold start waits for the session, then shows", async () => {
    server = installFakeServer("DRIVER");
    await storeRefreshToken(server.issue().refreshToken);
    server.outage = "network";
    await renderApp("driver", "/ride/abc123");
    await screen.findByText("Can't reach CampusRide");
    expect(screen.queryByText("Continue with phone number")).toBeNull();
    server.outage = null;
    await fireEvent.press(screen.getByText("Try again"));
    await screen.findByText("Driver trip");
    expect(pathname()).toBe("/ride/abc123");
  });

  it("the rider cancelling sends the driver Home by itself, signed in", async () => {
    await signInFresh("driver");
    await act(() => router.push("/ride/abc123?cancelled=1"));
    await screen.findByText("Driver trip");
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    await screen.findByText("Home screen");
    expect(history()).toEqual(["(tabs)"]);
  });
});

describe("signing out", () => {
  it("Log out on Account signs out and shows the sign-in screen", async () => {
    await launchSignedIn("rider");
    await screen.findByText("Home screen");
    await act(() => router.navigate("/account"));
    await fireEvent.press(await screen.findByText("Log out"));
    await screen.findByText("Continue with phone number");
    expect(pathname()).toBe("/auth/welcome");
    expect(await onDisk()).toBeNull();
    expect(server.calls).toContain("POST /auth/logout");
  });

  it("a revoked session (the server refuses it) signs out", async () => {
    await launchSignedIn("driver");
    await screen.findByText("Home screen");
    await fireEvent.press(screen.getByText("Open driver trip"));
    await screen.findByText("Driver trip");
    server.revokeAll();
    server.expireAccessTokens();
    // The trip screen's next request finds the session gone.
    await act(async () => {
      await getMe().catch(() => {});
    });
    await waitFor(() => expect(pathname()).toBe("/auth/welcome"));
    expect(await onDisk()).toBeNull();
  });
});
