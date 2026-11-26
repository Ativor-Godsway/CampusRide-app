import type { ReactNode } from "react";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { tripEndParams } from "@rida/shared";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, storeRefreshToken } from "./routes";
// The rider app's real Choose a ride screen.
import RideTypeScreen from "../../../../apps/rider/app/ride/type";

/**
 * Choose a ride with seats (2026-11-26), through the real screen against a
 * fake server. Pins:
 *   - Shared is chosen first, GH₵7, with "Bringing a friend?" − 1 seat +;
 *     the stepper changes the card's price and the button ("Request shared ·
 *     GH₵14"), and the 2- and 3-seat prices are never listed up front;
 *   - + at 3 seats suggests Ride alone for 4, and tapping it switches;
 *   - Ride alone's "How many people?" shows only while it is chosen; its
 *     price stays GH₵15;
 *   - the request carries the seats and the price shown for them;
 *   - an older server (no seat prices): no steppers, and no seats sent.
 */

jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({ on: () => {}, off: () => {} }),
  subscribeToRide: jest.fn(),
  unsubscribeFromRide: jest.fn(),
  resetRideSocket: jest.fn(),
}));

jest.mock("@gorhom/bottom-sheet", () => {
  const React = jest.requireActual<typeof import("react")>("react");
  const { View, TextInput } = jest.requireActual<typeof import("react-native")>("react-native");
  // The footer (the Request button) is drawn under the content, as on a phone.
  const Sheet = React.forwardRef(function Sheet(
    props: { children?: ReactNode; footerComponent?: (p: { animatedFooterPosition: unknown }) => ReactNode },
    ref,
  ) {
    React.useImperativeHandle(ref, () => ({ snapToIndex: () => {}, close: () => {}, expand: () => {} }));
    return React.createElement(View, null, props.children, props.footerComponent?.({ animatedFooterPosition: { value: 0 } }) ?? null);
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

jest.mock("../maps/CampusMapView", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const React = jest.requireActual<typeof import("react")>("react");
  return {
    ...jest.requireActual<object>("../maps/CampusMapView"),
    CampusMapView: () => React.createElement(View, { testID: "map" }),
  };
});

jest.setTimeout(30_000);

const PICKUP = { kind: "place" as const, latitude: 5.6494, longitude: -0.1861, label: "Akuafo Hall", placeId: "akuafo" };
const DROPOFF = { kind: "place" as const, latitude: 5.652, longitude: -0.187, label: "Balme Library", placeId: "balme" };

let server: FakeServer;
let booked: Record<string, unknown> | null;

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

/** As in the app, Choose a ride is only reached signed in. */
function SignedInChooseRide() {
  const { user } = useAuth();
  return user ? <RideTypeScreen /> : null;
}

async function openChooseRide(quote: object = { fares: { SHARED: 700, LONE: 1500 }, sharedBySeats: [700, 1400, 1800], farTrip: false }) {
  booked = null;
  await freshLaunch();
  server = installFakeServer("RIDER");
  server.routes["POST /rides/quote"] = () => quote;
  server.routes["POST /rides"] = (body) => {
    booked = body as Record<string, unknown>;
    return { ride: { id: "ride-new", status: "REQUESTED", passengers: [] } };
  };
  await storeRefreshToken(server.issue().refreshToken);
  const query = new URLSearchParams({ ...tripEndParams("pickup", PICKUP), ...tripEndParams("dropoff", DROPOFF) }).toString();
  await renderRouter({ _layout: Root, "ride/type": SignedInChooseRide }, { initialUrl: `/ride/type?${query}` });
  // renderRouter turns on fake timers; this screen's own (price glide, polls) run on the real clock.
  jest.useRealTimers();
  // requestAnimationFrame stayed on the fake clock: frames on the real one (the price glides).
  global.requestAnimationFrame = ((cb: (time: number) => void) =>
    setTimeout(() => cb(Date.now()), 16)) as unknown as typeof global.requestAnimationFrame;
  global.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof global.cancelAnimationFrame;
  await screen.findByText("Choose a ride", {}, { timeout: 8000 });
  await waitFor(() => expect(server.calls).toContain("POST /rides/quote"));
}

const press = async (testId: string) => {
  // The − and + buttons are one adjustable element for screen readers (the row).
  const el = await screen.findByTestId(testId, { includeHiddenElements: true });
  await act(async () => void (await fireEvent.press(el)));
};

describe("Choose a ride, with seats", () => {
  it("Shared first at GH₵7; the stepper changes the card and the button; 14 and 18 never listed up front", async () => {
    await openChooseRide();
    expect(await screen.findByText("Request shared · GH₵7")).toBeOnTheScreen();
    expect(screen.getByText("Share with students going your way")).toBeOnTheScreen();
    expect(screen.getByText("Bringing a friend?")).toBeOnTheScreen();
    expect(screen.getByText("1 seat")).toBeOnTheScreen();
    expect(screen.queryByText(/GH₵14|GH₵18/)).toBeNull();

    await press("shared-seats-plus");
    expect(screen.getByText("2 seats")).toBeOnTheScreen();
    expect(await screen.findByText("Request shared · GH₵14")).toBeOnTheScreen();
    await press("shared-seats-plus");
    expect(await screen.findByText("Request shared · GH₵18")).toBeOnTheScreen();
    await press("shared-seats-minus");
    expect(await screen.findByText("Request shared · GH₵14")).toBeOnTheScreen();
  });

  it("+ at 3 seats suggests Ride alone for 4; tapping it switches with 4 people at GH₵15", async () => {
    await openChooseRide();
    await press("shared-seats-plus");
    await press("shared-seats-plus");
    expect(screen.queryByText(/4 people\?/)).toBeNull();
    await press("shared-seats-plus");
    const hint = await screen.findByText("4 people? Ride alone fits you all for GH₵15.");
    expect(screen.getByText("3 seats")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(hint)));
    expect(await screen.findByText("Request ride alone · GH₵15")).toBeOnTheScreen();
    expect(screen.getByText("4 people")).toBeOnTheScreen();
    expect(screen.queryByText(/4 people\?/)).toBeNull();
  });

  it("Ride alone: 'How many people?' only while chosen, the price stays GH₵15", async () => {
    await openChooseRide();
    expect(screen.queryByText("How many people?")).toBeNull();
    await act(async () => void (await fireEvent.press(screen.getByText("Ride alone"))));
    expect(await screen.findByText("How many people?")).toBeOnTheScreen();
    expect(screen.getByText("The whole car, up to 4 people")).toBeOnTheScreen();
    await press("lone-people-plus");
    await press("lone-people-plus");
    expect(screen.getByText("3 people")).toBeOnTheScreen();
    // Ride alone is GH₵15 whatever the people.
    expect(await screen.findByText("Request ride alone · GH₵15")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByText("Shared"))));
    await waitFor(() => expect(screen.queryByText("How many people?")).toBeNull());
  });

  it("the request carries the seats and the price shown for them", async () => {
    await openChooseRide();
    await press("shared-seats-plus");
    const button = await screen.findByText("Request shared · GH₵14");
    await act(async () => void (await fireEvent.press(button)));
    await waitFor(() => expect(booked).not.toBeNull());
    expect(booked).toMatchObject({ type: "SHARED", seats: 2, shownFarePesewas: 1400 });
  });

  it("Ride alone for 3: seats 3 at GH₵15", async () => {
    await openChooseRide();
    await act(async () => void (await fireEvent.press(screen.getByText("Ride alone"))));
    await screen.findByText("How many people?");
    await press("lone-people-plus");
    await press("lone-people-plus");
    const button = await screen.findByText("Request ride alone · GH₵15");
    await act(async () => void (await fireEvent.press(button)));
    await waitFor(() => expect(booked).not.toBeNull());
    expect(booked).toMatchObject({ type: "LONE", seats: 3, shownFarePesewas: 1500 });
  });

  it("an older server (no seat prices): no steppers, and the request sends no seats", async () => {
    await openChooseRide({ fares: { SHARED: 700, LONE: 1500 }, farTrip: false });
    expect(await screen.findByText("Request shared · GH₵7")).toBeOnTheScreen();
    expect(screen.queryByText("Bringing a friend?")).toBeNull();
    await act(async () => void (await fireEvent.press(screen.getByText("Request shared · GH₵7"))));
    await waitFor(() => expect(booked).not.toBeNull());
    expect(booked).toMatchObject({ type: "SHARED", shownFarePesewas: 700 });
    expect(booked).not.toHaveProperty("seats");
  });

  it("a far trip says Shared costs more, without listing the seat prices", async () => {
    await openChooseRide({ fares: { SHARED: 900, LONE: 1500 }, sharedBySeats: [900, 1800, 2400], farTrip: true });
    expect(await screen.findByText(/north and south ends of campus, so Shared costs a little more/)).toBeOnTheScreen();
    expect(await screen.findByText("Request shared · GH₵9")).toBeOnTheScreen();
    expect(screen.queryByText(/GH₵18|GH₵24/)).toBeNull();
  });
});
