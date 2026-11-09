import { Linking, Text } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import * as SecureStore from "expo-secure-store";
import { NotificationsOffNotice, useNotificationsOffReminderOnce } from "../push/NotificationsOffNotice";

/**
 * "Notifications are off" after the person chose "Don't allow": the rider
 * app says it ONCE per install (never while the system prompt is still to
 * come), and the button opens the phone's settings for the app.
 */

const mockPhone = { permission: "denied" };
jest.mock("expo-notifications", () => ({
  getPermissionsAsync: jest.fn(async () => ({ status: mockPhone.permission })),
}));
jest.mock("expo-device", () => ({ isDevice: true }));
jest.mock("expo-constants", () => {
  const actual = jest.requireActual("expo-constants");
  return {
    ...actual,
    __esModule: true,
    default: new Proxy(actual.default, {
      get: (target, key) => (key === "executionEnvironment" ? "standalone" : Reflect.get(target, key)),
    }),
  };
});

const secureStore = SecureStore as unknown as { __store: Map<string, string> };

function RiderHome() {
  const reminder = useNotificationsOffReminderOnce(true);
  return reminder.show ? (
    <NotificationsOffNotice message="Notifications are off" onDismiss={reminder.dismiss} />
  ) : (
    <Text>Where to?</Text>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  secureStore.__store.clear();
  mockPhone.permission = "denied";
});

afterEach(() => jest.restoreAllMocks());

describe("the rider's 'notifications are off' reminder", () => {
  it("shows once after 'Don't allow', then never again", async () => {
    const first = await render(<RiderHome />);
    await settle();
    expect(screen.getByText("Notifications are off")).toBeTruthy();
    await first.unmount();

    // The next launch: not again.
    await render(<RiderHome />);
    await settle();
    expect(screen.queryByText("Notifications are off")).toBeNull();
    expect(screen.getByText("Where to?")).toBeTruthy();
  });

  it("isn't shown while the system prompt is still to come, or when they're on", async () => {
    for (const permission of ["undetermined", "granted"]) {
      mockPhone.permission = permission;
      const view = await render(<RiderHome />);
      await settle();
      expect(screen.queryByText("Notifications are off")).toBeNull();
      await view.unmount();
    }
    // Nothing was counted as shown.
    mockPhone.permission = "denied";
    await render(<RiderHome />);
    await settle();
    expect(screen.getByText("Notifications are off")).toBeTruthy();
  });

  it("Open settings opens the phone's settings; Not now hides it", async () => {
    const openSettings = jest.spyOn(Linking, "openSettings").mockResolvedValue();
    await render(<RiderHome />);
    await settle();
    await act(async () => {
      fireEvent.press(screen.getByText("Open settings"));
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Notifications are off")).toBeNull();
  });
});
