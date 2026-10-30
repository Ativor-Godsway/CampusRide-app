import { Pressable, Text } from "react-native";
import { Stack } from "expo-router";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { PushNotifications, usePushPermissionPrompt } from "../push/PushNotifications";
import { resetPushTokenMemoryForTests } from "../push/currentToken";
import {
  PUSH_SEND_MIN_INTERVAL_MS,
  registerForPush,
  resetPushRegistrationForTests,
} from "../push/registration";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, storeRefreshToken } from "./routes";

/**
 * Keeping this install's push token registered without flooding the server.
 *
 * The bug these guard against (first TestFlight builds): the token listener
 * fetched the token again, and both iOS and Android report every fetch to
 * the listener — changed or not — so the app sent PUT /me/push-token about
 * twenty times a second, for as long as it was open.
 */

/** The phone, as expo-notifications sees it. */
const mockPhone = {
  deviceToken: "apns-1",
  permission: "granted",
  listeners: new Set<(token: { type: string; data: string }) => void>(),
};

jest.mock("expo-notifications", () => {
  // As the native modules on both platforms do: every fetch of the token is
  // also reported to the token listeners, changed or not, as an event of its
  // own. (A loop then shows up as a failure — jest gives up on endless timers
  // — rather than a hang.)
  const getDevicePushTokenAsync = jest.fn(async () => {
    const token = { type: "ios", data: mockPhone.deviceToken };
    setTimeout(() => mockPhone.listeners.forEach((listener) => listener(token)), 0);
    return token;
  });
  return {
    AndroidImportance: { HIGH: 4 },
    AndroidNotificationVisibility: { PUBLIC: 1 },
    DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
    getPermissionsAsync: jest.fn(async () => ({ status: mockPhone.permission })),
    requestPermissionsAsync: jest.fn(async () => ({ status: mockPhone.permission })),
    setNotificationChannelAsync: jest.fn(async () => null),
    setNotificationHandler: jest.fn(),
    useLastNotificationResponse: () => null,
    clearLastNotificationResponseAsync: jest.fn(async () => {}),
    getDevicePushTokenAsync,
    // Without a phone token given, the real one fetches it first.
    getExpoPushTokenAsync: jest.fn(async (options?: { devicePushToken?: { data: string } }) => {
      const device = options?.devicePushToken ?? (await getDevicePushTokenAsync());
      return { type: "expo", data: `ExponentPushToken[${device.data}]` };
    }),
    addPushTokenListener: jest.fn((listener: (token: { type: string; data: string }) => void) => {
      mockPhone.listeners.add(listener);
      return { remove: () => mockPhone.listeners.delete(listener) };
    }),
  };
});

// A real phone running the installed app (push is off on simulators and in Expo Go).
jest.mock("expo-device", () => ({ isDevice: true, totalMemory: null, deviceYearClass: null }));
jest.mock("expo-constants", () => {
  const actual = jest.requireActual("expo-constants");
  return {
    ...actual,
    __esModule: true,
    default: new Proxy(actual.default, {
      get: (target, key) =>
        key === "executionEnvironment" ? "standalone" : Reflect.get(target, key),
    }),
  };
});

const notifications = Notifications as jest.Mocked<typeof Notifications>;
const secureStore = SecureStore as unknown as { __store: Map<string, string> };

let server: FakeServer;
/** The tokens the server was sent, in order. */
let sent: string[];

beforeEach(async () => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  secureStore.__store.clear();
  await freshLaunch();
  resetPushRegistrationForTests();
  resetPushTokenMemoryForTests();
  mockPhone.deviceToken = "apns-1";
  mockPhone.permission = "granted";
  mockPhone.listeners.clear();
  server = installFakeServer("RIDER");
  sent = [];
  server.routes["PUT /me/push-token"] = (body) => {
    sent.push((body as { token: string }).token);
    return { ok: true };
  };
});

const puts = () => server.calls.filter((c) => c === "PUT /me/push-token").length;

function Root() {
  return (
    <AuthProvider>
      <PushNotifications app="rider" showInForeground={() => true} onOpen={() => {}} />
      <Stack screenOptions={{ headerShown: false }} />
    </AuthProvider>
  );
}

function Home() {
  const { user, signOut } = useAuth();
  return (
    <>
      <Text>{user ? `Home, ${user.name}` : "Signed out"}</Text>
      <Pressable onPress={() => void signOut()}>
        <Text>Log out</Text>
      </Pressable>
    </>
  );
}

async function launchSignedIn() {
  await storeRefreshToken(server.issue().refreshToken);
  const app = await renderRouter({ _layout: Root, index: Home }, { initialUrl: "/" });
  await screen.findByText("Home, Ama Test");
  return app;
}

/** As a fresh launch of the app: nothing in memory, the keychain kept. */
async function relaunch(app: Awaited<ReturnType<typeof renderRouter>>) {
  app.unmount();
  await freshLaunch();
  resetPushRegistrationForTests();
  resetPushTokenMemoryForTests();
  return launchSignedIn();
}

async function wait(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** The phone reports a token to the listener (a fetch's echo, or a real change). */
async function reportToken(data: string) {
  await act(async () => {
    mockPhone.listeners.forEach((listener) => listener({ type: "ios", data }));
  });
}

describe("the token listener", () => {
  it("echoing every fetch of the token: one PUT at launch, and the token is fetched once", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    await wait(60_000);

    expect(puts()).toBe(1);
    expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
  });

  it("firing again and again with an unchanged token: still one PUT", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    for (let i = 0; i < 50; i++) await reportToken("apns-1");
    await wait(5 * 60_000);

    expect(puts()).toBe(1);
    expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
  });

  it("a changed token: exactly one more PUT, with the new token", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    await wait(PUSH_SEND_MIN_INTERVAL_MS);

    mockPhone.deviceToken = "apns-2";
    for (let i = 0; i < 10; i++) await reportToken("apns-2");
    await wait(5 * 60_000);

    expect(sent).toEqual(["ExponentPushToken[apns-1]", "ExponentPushToken[apns-2]"]);
  });

  it("a change right after a send waits for the minimum interval, then goes once", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));

    mockPhone.deviceToken = "apns-2";
    await reportToken("apns-2");
    expect(puts()).toBe(1);

    await wait(PUSH_SEND_MIN_INTERVAL_MS);
    await waitFor(() => expect(puts()).toBe(2));
    await wait(5 * 60_000);
    expect(sent).toEqual(["ExponentPushToken[apns-1]", "ExponentPushToken[apns-2]"]);
  });

  it("a listener that fetches the token again (the old bug) can't loop either", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    const subscription = Notifications.addPushTokenListener(() => void registerForPush("rider", "user-1"));
    await reportToken("apns-1");
    await wait(60_000);
    subscription.remove();

    expect(puts()).toBe(1);
    // Once at launch, then at most once per minimum interval.
    expect(notifications.getDevicePushTokenAsync.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("with the server failing and the token changing every second: a few PUTs a minute at most", async () => {
    server.routes["PUT /me/push-token"] = () => {
      throw new Error("server error");
    };
    await launchSignedIn();
    for (let i = 0; i < 180; i++) {
      await reportToken(`apns-rotated-${i}`);
      await wait(1_000);
    }

    // At launch, then backing off: 40 s later, then 80 s after that.
    expect(puts()).toBeGreaterThanOrEqual(2);
    expect(puts()).toBeLessThanOrEqual(3);
  });
});

describe("what the app remembers", () => {
  it("a relaunch with the same token and account: no PUT", async () => {
    const app = await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));

    await relaunch(app);
    await wait(60_000);

    expect(puts()).toBe(1);
  });

  it("someone else signed in on the phone: sent once, for them", async () => {
    const app = await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));

    server.user = { ...server.user, id: "user-2" };
    await relaunch(app);
    await waitFor(() => expect(puts()).toBe(2));
    await wait(60_000);

    expect(puts()).toBe(2);
  });

  it("log out forgets it, so the next sign-in sends the token again", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    expect(secureStore.__store.has("rida.push.sentToken")).toBe(true);

    await fireEvent.press(screen.getByText("Log out"));
    await screen.findByText("Signed out");
    expect(secureStore.__store.has("rida.push.sentToken")).toBe(false);
  });

  it("calls made while one is running are folded into one", async () => {
    await launchSignedIn();
    await waitFor(() => expect(puts()).toBe(1));
    await wait(PUSH_SEND_MIN_INTERVAL_MS);
    mockPhone.deviceToken = "apns-2";

    await act(async () => {
      await Promise.all(Array.from({ length: 20 }, () => registerForPush("rider", "user-1")));
    });
    await wait(60_000);

    expect(puts()).toBe(2);
    // Launch, then the first of the twenty. The other nineteen became one
    // follow-up, which used the token the listener had just reported.
    expect(notifications.getDevicePushTokenAsync).toHaveBeenCalledTimes(2);
  });
});

describe("while the app is open", () => {
  /** The rider app on a screen that already shows its ride's news live. */
  function QuietRoot() {
    return (
      <AuthProvider>
        <PushNotifications app="rider" showInForeground={() => false} onOpen={() => {}} />
        <Stack screenOptions={{ headerShown: false }} />
      </AuthProvider>
    );
  }

  async function shown(data: Record<string, unknown>) {
    const calls = notifications.setNotificationHandler.mock.calls;
    const handler = calls[calls.length - 1]?.[0];
    const notification = { request: { content: { data } } } as unknown as Notifications.Notification;
    return (await handler!.handleNotification(notification)).shouldShowBanner;
  }

  it("an admin notification shows as a banner; ride notifications still follow the screen", async () => {
    await storeRefreshToken(server.issue().refreshToken);
    await renderRouter({ _layout: QuietRoot, index: Home }, { initialUrl: "/" });
    await screen.findByText("Home, Ama Test");

    expect(await shown({ kind: "ANNOUNCEMENT" })).toBe(true);
    expect(await shown({ kind: "DRIVER_ARRIVED", rideId: "ride1" })).toBe(false);
    expect(await shown({ kind: "SOMETHING_ELSE" })).toBe(false);
  });

  it("nothing shows once signed out", async () => {
    const app = await launchSignedIn();
    await fireEvent.press(screen.getByText("Log out"));
    await screen.findByText("Signed out");
    expect(await shown({ kind: "ANNOUNCEMENT" })).toBe(false);
    app.unmount();
  });
});

describe("the notification explanation screen (asked once per install)", () => {
  function Prompt({ onOpen }: { onOpen: () => void }) {
    usePushPermissionPrompt(true, onOpen);
    return <Text>Prompt host</Text>;
  }

  const secureMock = SecureStore as unknown as { getItemAsync: jest.Mock; setItemAsync: jest.Mock };
  const readFromStore = async (key: string) => secureStore.__store.get(key) ?? null;

  afterEach(() => secureMock.getItemAsync.mockImplementation(readFromStore));

  it("asked under the old key: not asked again, and moved to a key readable while locked", async () => {
    mockPhone.permission = "undetermined";
    secureStore.__store.set("rida.pushPermissionAsked", "1");
    const open = jest.fn();
    await renderRouter({ index: () => <Prompt onOpen={open} /> }, { initialUrl: "/" });
    await wait(5_000);
    expect(open).not.toHaveBeenCalled();
    expect(secureMock.setItemAsync).toHaveBeenCalledWith("rida.push.permissionAsked", "1", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });

  it("a keychain that can't be read (phone locked): no error, not shown now", async () => {
    mockPhone.permission = "undetermined";
    secureMock.getItemAsync.mockRejectedValue(new Error("Calling the 'getValueWithKeyAsync' function has failed"));
    const open = jest.fn();
    await renderRouter({ index: () => <Prompt onOpen={open} /> }, { initialUrl: "/" });
    for (let i = 0; i < 30; i++) await wait(100);
    expect(open).not.toHaveBeenCalled();
  });
});
