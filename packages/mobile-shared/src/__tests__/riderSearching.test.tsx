import type { ReactNode } from "react";
import { act, renderRouter, screen, fireEvent, waitFor } from "expo-router/testing-library";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { RIDE_EVENTS, type RideSearchStatus } from "@rida/shared";
import { AuthProvider } from "../auth/AuthContext";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, storeRefreshToken } from "./routes";
// The rider app's real trip screen.
import RideTypeScreen from "../../../../apps/rider/app/ride/type";

/**
 * The rider's "Finding your driver" screen, through the real trip screen
 * (apps/rider/app/ride/type.tsx) against a fake server. Pins the hard rule:
 * the moment a driver accepts — at ANY step of the checklist — the screen is
 * "On the way" (the driver-found content); and:
 *   - no timer or countdown anywhere on the searching screen;
 *   - the counts shown are the server's, and none when it has none;
 *   - Cancel asks "Cancel your request? 3 drivers have it.";
 *   - when the search runs out, the "no driver found" options are the same
 *     as before (Search again, the switch, Cancel ride).
 */

type Handler = (payload: unknown) => void;
const mockHandlers = new Map<string, Set<Handler>>();
jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({
    on: (event: string, h: Handler) => {
      if (!mockHandlers.has(event)) mockHandlers.set(event, new Set());
      mockHandlers.get(event)!.add(h);
    },
    off: (event: string, h: Handler) => mockHandlers.get(event)?.delete(h),
  }),
  subscribeToRide: jest.fn(),
  unsubscribeFromRide: jest.fn(),
  resetRideSocket: jest.fn(),
}));

// The sheet as a plain view (its real one measures and animates natively).
jest.mock("@gorhom/bottom-sheet", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View, TextInput } = jest.requireActual<typeof import("react-native")>("react-native");
  const Sheet = React.forwardRef(function Sheet(props: { children?: ReactNode }, ref) {
    React.useImperativeHandle(ref, () => ({ snapToIndex: () => {}, close: () => {}, expand: () => {} }));
    return React.createElement(View, null, props.children);
  });
  const Pass = ({ children }: { children?: ReactNode }) => React.createElement(React.Fragment, null, children);
  return {
    __esModule: true,
    default: Sheet,
    BottomSheetBackdrop: Pass,
    BottomSheetFooter: Pass,
    BottomSheetScrollView: ({ children }: { children?: ReactNode }) => React.createElement(View, null, children),
    BottomSheetView: ({ children }: { children?: ReactNode }) => React.createElement(View, null, children),
    BottomSheetTextInput: TextInput,
  };
});

jest.setTimeout(30_000);
// The map draws natively; here it only records the cars it was given.
const mockMapCars: Array<readonly unknown[] | undefined> = [];
jest.mock("../maps/CampusMapView", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual<object>("../maps/CampusMapView"),
    CampusMapView: (props: { cars?: readonly unknown[] }) => {
      mockMapCars.push(props.cars);
      return React.createElement(View, { testID: "map" });
    },
  };
});

const RIDE_ID = "ride-1";
const SECOND = 1000;

let server: FakeServer;
let rideNow: Record<string, unknown>;
let driverNow: Record<string, unknown> | null;
let statusNow: RideSearchStatus | null;

function searchingRide(startedAgoMs: number, over: Record<string, unknown> = {}) {
  return {
    id: RIDE_ID,
    riderId: "user-1",
    driverId: null,
    type: "SHARED",
    status: "REQUESTED",
    occupancy: 1,
    cancelReason: null,
    mergedIntoRideId: null,
    pickupZoneId: "z1",
    dropoffZoneId: "z2",
    broadcastStartedAt: new Date(Date.now() - startedAgoMs).toISOString(),
    createdAt: new Date(Date.now() - startedAgoMs).toISOString(),
    passengers: [
      {
        id: "seat-1",
        rideId: RIDE_ID,
        riderId: "user-1",
        pickupZoneId: "z1",
        dropoffZoneId: "z2",
        status: "WAITING",
        lockedFare: 700,
        fareCharged: null,
      },
    ],
    ...over,
  };
}

const DRIVER = {
  driverId: "driver-9",
  name: "Kofi Mensah",
  phone: "+233241111111",
  carMake: "Toyota",
  carModel: "Vitz",
  carColor: "Silver",
  plate: "GR 1234-26",
  rating: 4.8,
  photoUrl: null,
};

function searchStatus(over: Partial<RideSearchStatus> = {}): RideSearchStatus {
  return {
    rideId: RIDE_ID,
    searchStartedAt: null,
    driversOffered: 3,
    driversWithIt: 3,
    scope: "nearby",
    carsChecked: 5,
    nearestFreeCarMeters: 300,
    driversOnTrips: null,
    firstInLine: true,
    usualWait: { fromMinutes: 1, toMinutes: 3 },
    freeWaitSeconds: 150,
    cars: [],
    ...over,
  };
}

function Root() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

async function openSearchingScreen(startedAgoMs: number, status: RideSearchStatus | null = searchStatus()) {
  rideNow = searchingRide(startedAgoMs);
  driverNow = null;
  statusNow = status;
  await freshLaunch();
  server = installFakeServer("RIDER");
  server.routes[`GET /rides/${RIDE_ID}`] = () => ({ ride: rideNow, driver: driverNow });
  server.routes[`GET /rides/${RIDE_ID}/search-status`] = () => ({ status: statusNow });
  await storeRefreshToken(server.issue().refreshToken);
  await renderRouter({ _layout: Root, "ride/type": RideTypeScreen }, { initialUrl: `/ride/type?rideId=${RIDE_ID}` });
  // renderRouter turns on jest's fake timers; this screen's own timers (the
  // steps, the tips, the polls, animations) run on the real clock here.
  jest.useRealTimers();
  await screen.findByText("Finding your driver", {}, { timeout: 8000 });
}

/** A server event to the app, then a tick (TanStack tells components on a setTimeout(0)). */
const send = (event: string, payload: unknown) =>
  act(async () => {
    for (const h of mockHandlers.get(event) ?? []) h(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** What a driver accepting does on the server, and what the app hears. */
async function driverAccepts() {
  rideNow = { ...rideNow, status: "MATCHED", driverId: DRIVER.driverId };
  driverNow = DRIVER;
  await send(RIDE_EVENTS.STATUS, { rideId: RIDE_ID, status: "MATCHED" });
  await send(RIDE_EVENTS.DRIVER_ASSIGNED, { rideId: RIDE_ID, ...DRIVER });
}

afterEach(() => {
  mockHandlers.clear();
});

describe("a driver accepts: straight to the driver-found screen, at every step", () => {
  it.each([
    ["sending (0 s)", 0, "Sending your request…"],
    ["finding drivers (10 s)", 10 * SECOND, "Finding drivers near you…"],
    ["checking cars (30 s)", 30 * SECOND, "Checking cars with free seats going your way…"],
    ["waiting for an accept (1 min)", 60 * SECOND, "Waiting for a driver to accept"],
    ["drivers finishing trips (3 min)", 180 * SECOND, "Waiting for a driver to accept"],
  ])("%s", async (_name, ago, stepText) => {
    await openSearchingScreen(ago);
    expect(await screen.findByText(stepText)).toBeOnTheScreen();
    await driverAccepts();
    // Nothing waits for the checklist: the searching screen is gone at once.
    expect(screen.queryByText("Finding your driver")).toBeNull();
    expect(screen.queryByText(stepText)).toBeNull();
    expect(await screen.findByText("On the way")).toBeOnTheScreen();
  });

  it("the accept arrives before the driver's details: 'Driver found' at once, never an empty sheet", async () => {
    await openSearchingScreen(30 * SECOND);
    rideNow = { ...rideNow, status: "MATCHED", driverId: DRIVER.driverId };
    driverNow = DRIVER;
    await send(RIDE_EVENTS.STATUS, { rideId: RIDE_ID, status: "MATCHED" });
    expect(screen.queryByText("Finding your driver")).toBeNull();
    expect(screen.getByText("Driver found")).toBeOnTheScreen();
    // The details follow (the event, or the app reads them itself).
    expect(await screen.findByText("On the way", {}, { timeout: 4000 })).toBeOnTheScreen();
  });
});

describe("the searching screen", () => {
  it("no timer or countdown anywhere", async () => {
    await openSearchingScreen(95 * SECOND);
    await screen.findByText("Shown to 3 drivers nearby");
    expect(screen.queryByText(/\d+:\d\d/)).toBeNull();
    expect(screen.queryByText(/Searching/)).toBeNull();
  });

  it("the server's real counts, the usual wait and the nearest free car", async () => {
    await openSearchingScreen(60 * SECOND);
    expect(await screen.findByText("Request sent")).toBeOnTheScreen();
    expect(screen.getByText("Shown to 3 drivers nearby")).toBeOnTheScreen();
    expect(screen.getByText("5 cars checked")).toBeOnTheScreen();
    expect(screen.getByText("Usually 1–3 min")).toBeOnTheScreen();
    expect(screen.getByText("A car with a free seat is 300 m away")).toBeOnTheScreen();
  });

  it("the free cars nearby show on the map while searching, and go once a driver accepts", async () => {
    const cars = [{ key: "k1", latitude: 5.65, longitude: -0.187, heading: 90 }];
    await openSearchingScreen(30 * SECOND, searchStatus({ cars }));
    await waitFor(() => expect(mockMapCars[mockMapCars.length - 1]).toEqual(cars));
    await driverAccepts();
    await screen.findByText("On the way");
    expect(mockMapCars[mockMapCars.length - 1]).toBeUndefined();
  });

  it("a status pushed over the socket updates the numbers", async () => {
    await openSearchingScreen(60 * SECOND);
    await screen.findByText("Shown to 3 drivers nearby");
    await send(RIDE_EVENTS.SEARCH_STATUS, searchStatus({ driversOffered: 1, scope: "campus", carsChecked: 1 }));
    expect(screen.getByText("Shown to 1 driver on campus")).toBeOnTheScreen();
    expect(screen.getByText("1 car checked")).toBeOnTheScreen();
  });

  it("no status from the server (an older one): wording without numbers", async () => {
    await openSearchingScreen(60 * SECOND, null);
    expect(await screen.findByText("Searched for drivers near you")).toBeOnTheScreen();
    expect(screen.getByText("Cars checked")).toBeOnTheScreen();
    expect(screen.queryByText(/Usually/)).toBeNull();
    expect(screen.queryByText(/free seat is/)).toBeNull();
  });

  it("drivers busy on trips after 2:30: says so, and 'first in line' only when it's true", async () => {
    await openSearchingScreen(160 * SECOND, searchStatus({ driversOnTrips: "nearby", firstInLine: false }));
    expect(await screen.findByText("Drivers are finishing nearby trips.")).toBeOnTheScreen();
    expect(screen.queryByText(/first in line/)).toBeNull();
  });
});

describe("cancel", () => {
  it("asks first: 'Cancel your request? 3 drivers have it.', Keep searching goes back", async () => {
    await openSearchingScreen(30 * SECOND);
    await waitFor(() => expect(server.calls).toContain(`GET /rides/${RIDE_ID}/search-status`));
    await fireEvent.press(screen.getByText("Cancel"));
    expect(await screen.findByText("Cancel your request?")).toBeOnTheScreen();
    expect(screen.getByText("3 drivers have it.")).toBeOnTheScreen();
    await fireEvent.press(screen.getByText("Keep searching"));
    expect(await screen.findByText("Finding your driver")).toBeOnTheScreen();
    expect(server.calls).not.toContain(`POST /rides/${RIDE_ID}/cancel`);
  });

  it("Cancel request goes on to the reason, and the line is left out with no real count", async () => {
    await openSearchingScreen(30 * SECOND, searchStatus({ driversWithIt: 0 }));
    await waitFor(() => expect(server.calls).toContain(`GET /rides/${RIDE_ID}/search-status`));
    await fireEvent.press(screen.getByText("Cancel"));
    await screen.findByText("Cancel your request?");
    expect(screen.queryByText(/have it|has it/)).toBeNull();
    await fireEvent.press(screen.getByText("Cancel request"));
    expect(await screen.findByText("Why are you cancelling?")).toBeOnTheScreen();
  });
});

describe("the search runs out", () => {
  it("the 'no driver found' options are unchanged", async () => {
    await openSearchingScreen(60 * SECOND);
    rideNow = { ...rideNow, status: "AWAITING_RIDER_DECISION" };
    await send(RIDE_EVENTS.STATUS, { rideId: RIDE_ID, status: "AWAITING_RIDER_DECISION" });
    expect(await screen.findByText("No drivers available right now")).toBeOnTheScreen();
    expect(screen.getByText("Search again")).toBeOnTheScreen();
    expect(screen.getByText(/^Switch to Ride alone · GH₵/)).toBeOnTheScreen();
    expect(screen.getByText("Cancel ride")).toBeOnTheScreen();
    expect(screen.queryByText("Try again")).toBeNull();
    expect(screen.queryByText("Finding your driver")).toBeNull();
  });
});

describe("the panel's motion", () => {
  /* eslint-disable @typescript-eslint/no-require-imports -- loaded after the mocks above */
  const { render } = require("@testing-library/react-native") as typeof import("@testing-library/react-native");
  const { AccessibilityInfo } = require("react-native") as typeof import("react-native");
  const { SearchingPanel } = require("../../../../apps/rider/components/ride/SearchingPanel") as typeof import("../../../../apps/rider/components/ride/SearchingPanel");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const panel = (ago: number) => (
    <SearchingPanel
      pickupPlaceName="Akuafo Hall"
      rideType="SHARED"
      priceLabel="GH₵7"
      broadcastStartedAt={new Date(Date.now() - ago).toISOString()}
      status={searchStatus()}
      onCancel={() => {}}
    />
  );

  afterEach(() => jest.restoreAllMocks());

  it("the tips fade from one to the next every 6 s", async () => {
    await render(panel(10 * SECOND));
    expect(screen.getByText("We'll notify you as soon as a driver accepts")).toBeOnTheScreen();
    expect(
      await screen.findByText("Be at the pickup: drivers wait 2½ min free", {}, { timeout: 8000 }),
    ).toBeOnTheScreen();
  }, 15_000);

  it("a spinner on the step under way; with Reduce Motion, a still ring instead", async () => {
    const first = await render(panel(10 * SECOND));
    expect(screen.getAllByTestId("search-step-spinner")).toHaveLength(1);
    await first.unmount();

    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    await render(panel(10 * SECOND));
    await waitFor(() => expect(screen.queryAllByTestId("search-step-spinner")).toHaveLength(0));
    expect(screen.getAllByTestId("search-step-still")).toHaveLength(1);
    // Same steps, same words.
    expect(screen.getByText("Finding drivers near Akuafo Hall…")).toBeOnTheScreen();
  });
});
