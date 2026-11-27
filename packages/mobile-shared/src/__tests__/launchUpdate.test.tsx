import { act, render, screen } from "@testing-library/react-native";
import { LaunchUpdateGate, resetLaunchUpdateForTests } from "../appUpdate";

/**
 * Faster updates: on a fresh launch, a newer bundle is downloaded behind
 * "Updating…" and the app reloads into it — never during a ride (then only
 * downloaded), never longer than 8 s, and only once per launch.
 */

jest.mock("expo-updates", () => ({
  isEnabled: true,
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(async () => undefined),
}));
const mockUpdates = jest.requireMock("expo-updates") as {
  isEnabled: boolean;
  checkForUpdateAsync: jest.Mock;
  fetchUpdateAsync: jest.Mock;
  reloadAsync: jest.Mock;
};

const g = globalThis as unknown as { __DEV__: boolean };
let dev: boolean;

beforeEach(() => {
  dev = g.__DEV__;
  g.__DEV__ = false;
  resetLaunchUpdateForTests();
  mockUpdates.isEnabled = true;
  mockUpdates.checkForUpdateAsync.mockReset();
  mockUpdates.fetchUpdateAsync.mockReset();
  mockUpdates.reloadAsync.mockClear();
});

afterEach(() => {
  g.__DEV__ = dev;
  jest.useRealTimers();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

it("an update and no ride: shows Updating… and reloads into it", async () => {
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  let finish: (v: { isNew: boolean }) => void = () => undefined;
  mockUpdates.fetchUpdateAsync.mockReturnValue(new Promise((r) => (finish = r)));
  await render(<LaunchUpdateGate app="rider" isRideActive={async () => false} />);
  await flush();
  expect(screen.getByText("Updating…")).toBeTruthy();
  await act(async () => finish({ isNew: true }));
  await flush();
  expect(mockUpdates.reloadAsync).toHaveBeenCalledTimes(1);
});

it("during a request or trip: downloads only (used next launch), no screen, no reload", async () => {
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  mockUpdates.fetchUpdateAsync.mockResolvedValue({ isNew: true });
  await render(<LaunchUpdateGate app="driver" isRideActive={async () => true} />);
  await flush();
  expect(screen.queryByText("Updating…")).toBeNull();
  expect(mockUpdates.fetchUpdateAsync).toHaveBeenCalledTimes(1);
  expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
});

it("can't tell whether a ride is going on: treated as yes", async () => {
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  mockUpdates.fetchUpdateAsync.mockResolvedValue({ isNew: true });
  await render(<LaunchUpdateGate app="rider" isRideActive={() => Promise.reject(new Error("offline"))} />);
  await flush();
  expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
});

it("slow download: gives up after 8 s and carries on with this version", async () => {
  jest.useFakeTimers();
  mockUpdates.checkForUpdateAsync.mockResolvedValue({ isAvailable: true });
  mockUpdates.fetchUpdateAsync.mockReturnValue(new Promise(() => undefined));
  await render(<LaunchUpdateGate app="rider" isRideActive={async () => false} />);
  await flush();
  expect(screen.getByText("Updating…")).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(8_100);
  });
  await flush();
  expect(screen.queryByText("Updating…")).toBeNull();
  expect(mockUpdates.reloadAsync).not.toHaveBeenCalled();
});

it("offline, nothing new, or updates off: nothing shows; and it checks once per launch", async () => {
  mockUpdates.checkForUpdateAsync.mockRejectedValue(new Error("offline"));
  const { unmount } = await render(<LaunchUpdateGate app="rider" isRideActive={async () => false} />);
  await flush();
  expect(screen.queryByText("Updating…")).toBeNull();
  unmount();
  // Remounted in the same launch (e.g. back from the background): no second check.
  await render(<LaunchUpdateGate app="rider" isRideActive={async () => false} />);
  await flush();
  expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);

  resetLaunchUpdateForTests();
  mockUpdates.isEnabled = false;
  await render(<LaunchUpdateGate app="rider" isRideActive={async () => false} />);
  await flush();
  expect(mockUpdates.checkForUpdateAsync).toHaveBeenCalledTimes(1);
});
