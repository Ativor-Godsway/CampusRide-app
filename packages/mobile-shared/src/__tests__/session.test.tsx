import { AppState, Pressable, Text } from "react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { api, rawApi } from "../auth/apiClient";
import { getStoredRefreshToken } from "../auth/storage";
import { getAccessToken } from "../auth/tokenStore";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, onDisk, storeRefreshToken } from "./routes";

/**
 * The rule these tests hold the session code to: only the person's own
 * "Log out", or a session the server has truly ended (revoked, expired,
 * account deleted — a 401 to the refresh token), signs them out. A lost
 * connection, a server restarting, a slow answer, a rate limit, a locked
 * phone, an expired access token: they stay signed in, and it recovers.
 */

const secureStore = SecureStore as unknown as {
  __store: Map<string, string>;
  getItemAsync: jest.Mock;
  setItemAsync: jest.Mock;
};

let server: FakeServer;
let appStateListener: ((state: string) => void) | null = null;

beforeEach(async () => {
  jest.useFakeTimers();
  secureStore.__store.clear();
  await freshLaunch();
  server = installFakeServer("RIDER");
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    appStateListener = listener as (state: string) => void;
    return { remove: () => (appStateListener = null) } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  secureStore.getItemAsync.mockImplementation(async (key: string) => secureStore.__store.get(key) ?? null);
  secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
    secureStore.__store.set(key, value);
  });
});

function Probe() {
  const { isLoading, isAuthenticated, sessionProblem, user, signOut, retrySession } = useAuth();
  const state = isLoading ? (sessionProblem ? "unreachable" : "loading") : isAuthenticated ? `signed in as ${user?.name}` : "signed out";
  return (
    <>
      <Text testID="state">{state}</Text>
      <Pressable onPress={() => void signOut()}>
        <Text>Log out</Text>
      </Pressable>
      <Pressable onPress={retrySession}>
        <Text>Try again</Text>
      </Pressable>
    </>
  );
}

const state = () => screen.getByTestId("state").props.children as string;

async function launch() {
  await render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

async function launchSignedIn() {
  await storeRefreshToken(server.issue().refreshToken);
  await launch();
  await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
}

/** Lets timers (retry back-off) run. */
async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/**
 * Lets `ms` pass in small steps, so work scheduled after each await (a
 * keychain read's next try) runs too: one big jump fires only the timers
 * that already exist.
 */
async function waitInSteps(ms: number, step = 100) {
  for (let passed = 0; passed < ms; passed += step) await wait(step);
}

describe("opening the app (killed and reopened)", () => {
  it("restores the stored session", async () => {
    await launchSignedIn();
    expect(server.calls.filter((c) => c === "POST /auth/refresh")).toHaveLength(1);
  });

  it("with no stored session: signed out, nothing asked of the server", async () => {
    await launch();
    await waitFor(() => expect(state()).toBe("signed out"));
    expect(server.calls).toEqual([]);
  });

  it.each([
    ["no connection", "network"],
    ["the server restarting", "server-error"],
    ["a slow server (timeout)", "timeout"],
    ["a wrong or half-moved address (404)", "not-found"],
  ] as const)("with %s: stays signed in, says so, and recovers by itself", async (_label, outage) => {
    await storeRefreshToken(server.issue().refreshToken);
    server.outage = outage;
    await launch();
    await waitFor(() => expect(state()).toBe("unreachable"));
    await wait(10_000);
    expect(state()).toBe("unreachable");
    expect(await onDisk()).not.toBeNull();

    server.outage = null;
    await wait(30_000);
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
  });

  it("recovers at once when the app comes back to the foreground", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    server.outage = "network";
    await launch();
    await waitFor(() => expect(state()).toBe("unreachable"));
    server.outage = null;
    await act(async () => appStateListener?.("active"));
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
  });

  it("\"Try again\" retries straight away", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    server.outage = "network";
    await launch();
    await waitFor(() => expect(state()).toBe("unreachable"));
    server.outage = null;
    await fireEvent.press(screen.getByText("Try again"));
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
  });

  it("with the keychain locked (iPhone locked, driver app in the background): waits, then restores", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    secureStore.getItemAsync.mockRejectedValue(new Error("User interaction is not allowed."));
    await launch();
    // Each read is tried a few times first (auth/keychain.ts).
    await waitInSteps(3_000);
    expect(state()).toBe("unreachable");
    secureStore.getItemAsync.mockImplementation(async (key: string) => secureStore.__store.get(key) ?? null);
    await act(async () => appStateListener?.("active"));
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
  });

  it("finds a session stored by the previous app version", async () => {
    await SecureStore.setItemAsync("rida.refreshToken", server.issue().refreshToken);
    await launch();
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
    // Moved to the new key, readable while the phone is locked.
    expect(secureStore.__store.has("rida.refreshToken")).toBe(false);
    expect(await onDisk()).not.toBeNull();
    expect(secureStore.setItemAsync).toHaveBeenCalledWith("rida.session.refreshToken", expect.any(String), {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });

  it("with a revoked session: signs out and forgets it", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    server.revokeAll();
    await launch();
    await waitFor(() => expect(state()).toBe("signed out"));
    expect(await onDisk()).toBeNull();
  });

  it("for a deleted account: signs out", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    server.deleteAccount();
    await launch();
    await waitFor(() => expect(state()).toBe("signed out"));
    expect(await onDisk()).toBeNull();
  });

  it("while another request needs a token at the same moment: one refresh, not two", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    // Presenting the same token twice would end the session (reuse), were it
    // not for the server's retry window — make sure the app never relies on it.
    server.refreshTokenReuseGraceMs = 0;
    server.slow = { path: "POST /auth/refresh", ms: 3_000 };
    await launch();
    // The launch refresh is still on its way when another request needs a token.
    expect(server.calls).toEqual(["POST /auth/refresh"]);
    const other = api.get("/me");
    await wait(5_000);
    await expect(other).resolves.toBeTruthy();
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
    expect(server.calls.filter((c) => c === "POST /auth/refresh")).toHaveLength(1);
  });
});

describe("while using the app", () => {
  beforeEach(async () => {
    await launchSignedIn();
    server.calls = [];
  });

  it("an expired access token is refreshed and the request goes through", async () => {
    server.routes["GET /rides/active"] = () => ({ ride: null });
    server.expireAccessTokens();
    const res = await api.get("/rides/active");
    expect(res.data).toEqual({ ride: null });
    expect(server.calls).toEqual(["GET /rides/active", "POST /auth/refresh", "GET /rides/active"]);
    expect(state()).toBe("signed in as Ama Test");
  });

  it("several requests expiring together share one refresh", async () => {
    server.refreshTokenReuseGraceMs = 0;
    server.routes["GET /rides/active"] = () => ({ ride: null });
    server.expireAccessTokens();
    await Promise.all([api.get("/rides/active"), api.get("/rides/active"), api.get("/me")]);
    expect(server.calls.filter((c) => c === "POST /auth/refresh")).toHaveLength(1);
    expect(state()).toBe("signed in as Ama Test");
  });

  it.each([
    ["the network drops mid-trip", "network"],
    ["the server restarts", "server-error"],
    ["a request times out", "timeout"],
  ] as const)("%s: requests fail, the person stays signed in", async (_label, outage) => {
    server.outage = outage;
    server.expireAccessTokens();
    await expect(api.get("/me")).rejects.toBeTruthy();
    await wait(60_000);
    expect(state()).toBe("signed in as Ama Test");
    expect(await onDisk()).not.toBeNull();

    server.outage = null;
    await expect(api.get("/me")).resolves.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");
  });

  it("a refresh the server served but whose answer was lost: the retry keeps them signed in", async () => {
    server.expireAccessTokens();
    server.loseResponses = { path: "POST /auth/refresh", count: 1 };
    await expect(api.get("/me")).rejects.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");

    // Still holding the old token, the app tries again when back online.
    await expect(api.get("/me")).resolves.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");
    expect(server.liveRefreshTokens()).toEqual([await getStoredRefreshToken()]);
  });

  it("(why the server's retry window exists: without it, that lost answer signs them out)", async () => {
    server.refreshTokenReuseGraceMs = 0;
    server.expireAccessTokens();
    server.loseResponses = { path: "POST /auth/refresh", count: 1 };
    await expect(api.get("/me")).rejects.toBeTruthy();
    await expect(api.get("/me")).rejects.toBeTruthy();
    await waitFor(() => expect(state()).toBe("signed out"));
  });

  it("a refresh whose new token couldn't be saved (locked phone): the app keeps using it", async () => {
    server.refreshTokenReuseGraceMs = 0;
    secureStore.setItemAsync.mockRejectedValue(new Error("User interaction is not allowed."));
    server.expireAccessTokens();
    await expect(api.get("/me")).resolves.toBeTruthy();

    // The next refresh uses the new token from memory, not the stale one on disk.
    server.expireAccessTokens();
    await expect(api.get("/me")).resolves.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");

    // Saved once the keychain is available again.
    secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      secureStore.__store.set(key, value);
    });
    await getStoredRefreshToken();
    await waitFor(async () => expect(await onDisk()).toBe(server.liveRefreshTokens()[0]));
  });

  it("a rate limit (429) is not a sign-out", async () => {
    server.routes["GET /rides/active"] = () => ({ ride: null });
    const adapter = rawApi.defaults.adapter as (c: unknown) => Promise<unknown>;
    let first = true;
    rawApi.defaults.adapter = (config) => {
      if (first && config.url === "/auth/refresh") {
        first = false;
        return Promise.reject(Object.assign(new Error("429"), { config, response: { status: 429, data: {} } }));
      }
      return adapter(config) as never;
    };
    server.expireAccessTokens();
    await expect(api.get("/rides/active")).rejects.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");
    await expect(api.get("/rides/active")).resolves.toBeTruthy();
  });

  it("a refused action (403) is not a sign-out", async () => {
    const adapter = api.defaults.adapter as (c: unknown) => Promise<unknown>;
    api.defaults.adapter = (config) =>
      config.url === "/admin/thing"
        ? Promise.reject(Object.assign(new Error("403"), { config, response: { status: 403, data: {} } }))
        : (adapter(config) as never);
    await expect(api.get("/admin/thing")).rejects.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");
    expect(server.calls).not.toContain("POST /auth/refresh");
  });

  it("a 404 is not a sign-out", async () => {
    await expect(api.get("/rides/nope")).rejects.toBeTruthy();
    expect(state()).toBe("signed in as Ama Test");
  });

  it("coming back from the background changes nothing", async () => {
    await act(async () => appStateListener?.("background"));
    await act(async () => appStateListener?.("active"));
    expect(state()).toBe("signed in as Ama Test");
    expect(server.calls).toEqual([]);
  });

  it("the session revoked on the server: the next request signs out", async () => {
    server.revokeAll();
    server.expireAccessTokens();
    await expect(api.get("/me")).rejects.toBeTruthy();
    await waitFor(() => expect(state()).toBe("signed out"));
    expect(await onDisk()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("Log out signs out, forgets the session, and tells the server", async () => {
    await fireEvent.press(screen.getByText("Log out"));
    await waitFor(() => expect(state()).toBe("signed out"));
    expect(await onDisk()).toBeNull();
    expect(server.calls).toContain("POST /auth/logout");
  });
});

describe("a keychain that can't be read for a moment (Sentry CAMPUSRIDE-DRIVER-2)", () => {
  it("a read that fails once (the app just woke in the background): tried again, signed in", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    secureStore.getItemAsync.mockRejectedValueOnce(new Error("Calling the 'getValueWithKeyAsync' function has failed"));
    await launch();
    await waitFor(() => expect(state()).toBe("signed in as Ama Test"));
    expect(secureStore.getItemAsync.mock.calls.filter(([key]) => key === "rida.session.refreshToken").length).toBeGreaterThanOrEqual(2);
  });

  it("still unreadable after the retries: never signed out, and the session is kept", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    secureStore.getItemAsync.mockRejectedValue(new Error("User interaction is not allowed."));
    await launch();
    await waitInSteps(30_000, 500);
    expect(state()).toBe("unreachable");
    expect(await secureStore.__store.get("rida.session.refreshToken")).toBeTruthy();
  });

  it("Log out isn't blocked by it: the session is forgotten, and signed out at the next check", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    secureStore.getItemAsync.mockRejectedValue(new Error("User interaction is not allowed."));
    await launch();
    await waitInSteps(3_000);
    expect(state()).toBe("unreachable");
    await fireEvent.press(screen.getByText("Log out"));
    await waitInSteps(5_000);
    expect(secureStore.__store.has("rida.session.refreshToken")).toBe(false);
    expect(state()).toBe("signed out");
  });
});
