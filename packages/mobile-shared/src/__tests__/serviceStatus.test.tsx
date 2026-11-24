import { Text } from "react-native";
import { act, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AxiosAdapter, InternalAxiosRequestConfig } from "axios";
import { SERVICE_STATUS_EVENT } from "@rida/shared";
import { api } from "../auth/apiClient";
import { useServiceStatus } from "../service";

/**
 * Service hours as the apps run them: the real hook against a stand-in for
 * GET /me/service-status, and a stand-in socket that pushes live changes.
 */

jest.mock("../auth/AuthContext", () => ({
  useAuth: () => ({ isAuthenticated: true, user: { role: "RIDER" } }),
}));

const mockHandlers = new Map<string, (payload?: unknown) => void>();
jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({
    on: (event: string, fn: (payload?: unknown) => void) => mockHandlers.set(event, fn),
    off: (event: string) => mockHandlers.delete(event),
  }),
}));

// Tuesday 24 November 2026, 18:00 in Accra (= UTC): closed since 17:00.
const NOW = Date.parse("2026-11-24T18:00:00.000Z");
let answer: Record<string, unknown>;
const original = api.defaults.adapter;

const closed = {
  open: false,
  reason: "SCHEDULE",
  nextOpenAt: "2026-11-25T08:00:00.000Z",
  closesAt: null,
  message: null,
  today: { open: "08:00", close: "17:00" },
};

const adapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => ({
  data: { ...answer, serverTime: new Date(Date.now()).toISOString() },
  status: 200,
  statusText: "OK",
  headers: {},
  config,
});

function Probe() {
  const { view } = useServiceStatus();
  return (
    <Text>
      {view.kind === "closed" ? `${view.title} ${view.detail ?? ""}` : view.kind === "noDrivers" ? view.title : "open"}
    </Text>
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    jest.advanceTimersByTime(0);
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
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
  jest.useFakeTimers({ now: NOW });
  api.defaults.adapter = adapter;
  mockHandlers.clear();
  answer = { ...closed, exempt: false, notifyMe: false };
});

afterEach(() => {
  api.defaults.adapter = original;
  jest.useRealTimers();
});

it("shows when CampusRide is back, and opens live when the server says so", async () => {
  await show();
  expect(screen.getByText("CampusRide is closed. We're back at 8:00 AM tomorrow.")).toBeTruthy();

  // Open now in the admin site: the socket says so, with no new request.
  await act(async () => {
    mockHandlers.get(SERVICE_STATUS_EVENT)?.({
      ...closed,
      open: true,
      reason: "MANUAL",
      nextOpenAt: null,
      closesAt: "2026-11-25T17:00:00.000Z",
      serverTime: new Date(NOW).toISOString(),
    });
  });
  await settle();
  expect(screen.getByText("open")).toBeTruthy();
});

it("says no drivers are online", async () => {
  answer = { ...closed, reason: "NO_DRIVERS", nextOpenAt: null, closesAt: "2026-11-24T19:00:00.000Z", exempt: false };
  await show();
  expect(screen.getByText("No drivers online right now – try again shortly.")).toBeTruthy();
});

it("never shows the banner to review demo accounts", async () => {
  answer = { ...closed, exempt: true };
  await show();
  expect(screen.getByText("open")).toBeTruthy();
});
