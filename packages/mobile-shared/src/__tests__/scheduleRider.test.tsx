import { useState, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { act, fireEvent, renderRouter, screen, waitFor } from "expo-router/testing-library";
import { render } from "@testing-library/react-native";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { tripEndParams, type ScheduleOptions, type ScheduleSlotView, type ScheduledBookingView } from "@rida/shared";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch, storeRefreshToken } from "./routes";
// The rider app's real screens.
import ScheduleScreen, { tileWidth } from "../../../../apps/rider/app/ride/schedule";
import ScheduleConfirmScreen from "../../../../apps/rider/app/ride/schedule-confirm";
import { UpcomingRideCard, cancelQuestion } from "../../../../apps/rider/components/schedule/UpcomingRideCard";
import { ScheduleIntroSheet } from "../../../../apps/rider/components/schedule/ScheduleIntroSheet";

/**
 * Scheduled rides in the rider app (rides/scheduled.ts), the real screens
 * against a fake server:
 *  - the Schedule screen: "Join a car" chips with the message above them,
 *    the hour strip and tiles, the seat stepper, and "Reserve seat · 9:00 ·
 *    GH₵7" carrying the slot, seats, car and the price shown;
 *  - "Need a ride sooner?" for a slot under 20 minutes away with no car;
 *  - the Home card (seats filled, status, driver, window, I'm coming, Cancel);
 *  - the intro's title, three steps and buttons.
 */

jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({ on: () => {}, off: () => {} }),
  subscribeToRide: jest.fn(),
  unsubscribeFromRide: jest.fn(),
  resetRideSocket: jest.fn(),
}));

jest.setTimeout(30_000);

const PICKUP = { kind: "place" as const, latitude: 5.6494, longitude: -0.1861, label: "Akuafo Hall", placeId: "akuafo" };
const DROPOFF = { kind: "place" as const, latitude: 5.652, longitude: -0.187, label: "Balme Library", placeId: "balme" };

/** A tomorrow slot at h:m (UTC = Accra). */
function tomorrow(h: number, m = 0): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, h, m)).toISOString();
}

function options(slots: { today?: ScheduleSlotView[]; tomorrow?: ScheduleSlotView[] }): ScheduleOptions {
  return {
    enabled: true,
    blockedUntil: null,
    blockedText: null,
    days: [
      { day: "today", slots: slots.today ?? [] },
      { day: "tomorrow", slots: slots.tomorrow ?? [] },
    ],
    sharedBySeats: [700, 1400, 1800],
    farTrip: false,
    settings: { slotMinutes: 10, bookingCutoffMinutes: 20, freeCancelMinutes: 30, carSeats: 4 },
    serverTime: new Date().toISOString(),
  };
}

const slot = (arriveBy: string, extra: Partial<ScheduleSlotView> = {}): ScheduleSlotView => ({ arriveBy, bookable: true, going: 0, join: null, ...extra });

let server: FakeServer;
let booked: Record<string, unknown> | null;

function Root({ children }: { children?: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={client}>
        <AuthProvider>{children ?? <Stack screenOptions={{ headerShown: false }} />}</AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function SignedInSchedule() {
  const { user } = useAuth();
  return user ? <ScheduleScreen /> : null;
}

async function openSchedule(answer: ScheduleOptions) {
  booked = null;
  await freshLaunch();
  server = installFakeServer("RIDER");
  server.routes["POST /rides/scheduled/options"] = () => answer;
  server.routes["POST /rides/scheduled"] = (body) => {
    booked = body as Record<string, unknown>;
    return { booking: { id: "b1" } };
  };
  await storeRefreshToken(server.issue().refreshToken);
  const query = new URLSearchParams({ ...tripEndParams("pickup", PICKUP), ...tripEndParams("dropoff", DROPOFF) }).toString();
  await renderRouter({ _layout: () => <Root />, "ride/schedule": SignedInSchedule, "(tabs)/index": () => null }, { initialUrl: `/ride/schedule?${query}` });
  // Anything started on renderRouter's fake clock (sign-in, the first fetch) finishes, then the real clock.
  for (let i = 0; i < 5; i++) await act(async () => void jest.advanceTimersByTime(500));
  jest.useRealTimers();
  await screen.findByText("When do you need to arrive?", {}, { timeout: 8000 });
  await waitFor(() => expect(server.calls).toContain("POST /rides/scheduled/options"));
}

describe("the Schedule screen", () => {
  // Slots are put on tomorrow's date so they're always still to come; the screen shows them as today's list.
  const MORNING = [
    slot(tomorrow(9, 0), { going: 2 }),
    slot(tomorrow(9, 10), { going: 3, join: { carId: "car-k", driverFirstName: "Kofi", seatsLeft: 1 } }),
    slot(tomorrow(9, 20)),
    slot(tomorrow(13, 0)),
    slot(tomorrow(13, 10), { bookable: false }),
  ];

  it("today only, no day toggle: the banner, join chips, 12-hour 'Arrive by' hours, wide tiles with who's going", async () => {
    await openSchedule(options({ today: MORNING }));
    expect(await screen.findByText("Join cars going your way. They fill faster and get confirmed sooner.")).toBeOnTheScreen();
    expect(screen.queryByText("Tomorrow")).toBeNull();
    expect(screen.getByText("Arrive by")).toBeOnTheScreen();
    expect(screen.getByText("9 AM")).toBeOnTheScreen();
    expect(screen.getByText("1 PM")).toBeOnTheScreen();
    expect(screen.getByText("9:10 AM · Join Kofi's car · 1 seat left")).toBeOnTheScreen();
    expect(screen.getByText("9:00 AM · 2 going")).toBeOnTheScreen();
    // A tile: the time big, and under it who's going your way.
    expect(screen.getByText("2 going your way")).toBeOnTheScreen();
    expect(screen.getAllByText("9:20").length).toBe(1);
    // A closed slot (no car to join) isn't shown at all.
    await act(async () => void (await fireEvent.press(screen.getByLabelText("1 PM hour"))));
    expect(await screen.findByTestId("slot-1:00 PM")).toBeOnTheScreen();
    expect(screen.queryByTestId("slot-1:10 PM")).toBeNull();
  });

  it("the button always names the slot picked: changing the hour clears it until a time is picked", async () => {
    await openSchedule(options({ today: MORNING }));
    // The car with a driver is picked first.
    expect(await screen.findByText("Continue · arrive by 9:10 AM")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByLabelText("1 PM hour"))));
    expect(await screen.findByText("Choose a time")).toBeOnTheScreen();
    expect(screen.queryByText(/9:10 AM$/)).toBeNull();
    await act(async () => void (await fireEvent.press(screen.getByTestId("slot-1:00 PM"))));
    expect(await screen.findByText("Continue · arrive by 1:00 PM")).toBeOnTheScreen();
  });

  it("slots under 20 minutes away are hidden; 'Need a ride sooner?' says so", async () => {
    const soon = new Date(Math.floor((Date.now() + 15 * 60_000) / 600_000) * 600_000 + 600_000);
    const close = soon.getTime() - Date.now() < 20 * 60_000 ? soon : new Date(soon.getTime() - 600_000);
    await openSchedule(options({ today: [slot(close.toISOString(), { bookable: false }), slot(tomorrow(9, 0))] }));
    expect(await screen.findByText("Need a ride sooner? Book a normal ride instead.")).toBeOnTheScreen();
  });
});

describe("tile layout", () => {
  it("two tiles a row, as wide as the row allows (no squeezed '9:00')", () => {
    expect(tileWidth(350)).toBe(169);
    expect(tileWidth(300)).toBeGreaterThanOrEqual(140);
  });
});

describe("confirm", () => {
  it("says it's scheduled, shows the trip, and reserves what was picked", async () => {
    booked = null;
    await freshLaunch();
    server = installFakeServer("RIDER");
    server.routes["POST /rides/scheduled"] = (body) => {
      booked = body as Record<string, unknown>;
      return { booking: { id: "b1" } };
    };
    await storeRefreshToken(server.issue().refreshToken);
    const arriveBy = tomorrow(9, 20);
    const query = new URLSearchParams({
      ...tripEndParams("pickup", PICKUP),
      ...tripEndParams("dropoff", DROPOFF),
      arriveBy,
      seats: "2",
      fare: "1400",
      freeCancel: "30",
      carId: "car-k",
      driver: "Kofi",
    }).toString();
    const Confirm = () => (useAuth().user ? <ScheduleConfirmScreen /> : null);
    await renderRouter({ _layout: () => <Root />, "ride/schedule-confirm": Confirm, "(tabs)/index": () => null }, { initialUrl: `/ride/schedule-confirm?${query}` });
    for (let i = 0; i < 5; i++) await act(async () => void jest.advanceTimersByTime(500));
    jest.useRealTimers();
    expect(await screen.findByText(/^Scheduled · arrive by 9:20 AM/, {}, { timeout: 8000 })).toBeOnTheScreen();
    expect(screen.getByText("Akuafo Hall")).toBeOnTheScreen();
    expect(screen.getByText("Balme Library")).toBeOnTheScreen();
    expect(screen.getByText("Joining Kofi's car")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByText("Reserve 2 seats · GH₵14"))));
    await waitFor(() => expect(booked).not.toBeNull());
    expect(booked).toMatchObject({ arriveBy, seats: 2, shownFarePesewas: 1400, carId: "car-k" });
  });
});

const BOOKING: ScheduledBookingView = {
  id: "b1",
  carId: "c1",
  arriveBy: tomorrow(9),
  status: "BOOKED",
  state: "CAR_CONFIRMED",
  seats: 1,
  farePesewas: 700,
  carSeatsTaken: 3,
  carSeats: 4,
  pickupLabel: "Akuafo Hall",
  dropoffLabel: "Balme Library",
  driver: { firstName: "Kofi", carColor: "Silver", carMake: "Toyota", carModel: "Vitz", plate: "GT 1234-24", photoUrl: null },
  pickupWindow: { start: tomorrow(8, 38), end: tomorrow(8, 45) },
  freeCancelUntil: tomorrow(8, 30),
  coming: false,
  rideId: null,
  serverTime: new Date().toISOString(),
};

describe("the Home card", () => {
  it("seats filled, status, driver and car, pickup window, I'm coming and Cancel", async () => {
    await freshLaunch();
    server = installFakeServer("RIDER");
    await render(
      <Root>
        <UpcomingRideCard booking={BOOKING} />
      </Root>,
    );
    expect(screen.getByText("3 of 4 seats filled")).toBeOnTheScreen();
    expect(screen.getByText("Car confirmed")).toBeOnTheScreen();
    expect(screen.getByText("Kofi · a silver Toyota Vitz · GT 1234-24")).toBeOnTheScreen();
    expect(screen.getByText("Be ready 8:38–8:45 AM at Akuafo Hall")).toBeOnTheScreen();
    expect(screen.getByText("I'm coming")).toBeOnTheScreen();
    expect(screen.getByText("Cancel")).toBeOnTheScreen();
  });

  it("waiting for riders: no driver yet, no I'm coming", async () => {
    await render(
      <Root>
        <UpcomingRideCard booking={{ ...BOOKING, state: "WAITING_FOR_RIDERS", driver: null, pickupWindow: null, carSeatsTaken: 1 }} />
      </Root>,
    );
    expect(screen.getByText("Waiting for riders")).toBeOnTheScreen();
    expect(screen.getByText("1 of 4 seats filled")).toBeOnTheScreen();
    expect(screen.queryByText("I'm coming")).toBeNull();
  });

  it("the cancel question says free, or a strike", () => {
    expect(cancelQuestion(BOOKING, Date.parse(tomorrow(8, 0)))).toMatch(/free/);
    expect(cancelQuestion(BOOKING, Date.parse(tomorrow(8, 40)))).toMatch(/strike/);
  });
});

describe("the intro", () => {
  it("title, the three steps and the three ways out", async () => {
    const onClose = jest.fn();
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>
        <ScheduleIntroSheet visible onClose={onClose} />
      </SafeAreaProvider>,
    );
    expect(screen.getByText("Book your ride ahead")).toBeOnTheScreen();
    for (const t of ["Schedule ahead", "Join a car going your way", "Picked up on time"]) expect(screen.getByText(t)).toBeOnTheScreen();
    expect(screen.getByText("Share with students heading the same way. From GH₵7.")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByText("Don't show again"))));
    expect(onClose).toHaveBeenLastCalledWith("never");
    await act(async () => void (await fireEvent.press(screen.getByText("Maybe later"))));
    expect(onClose).toHaveBeenLastCalledWith("later");
    await act(async () => void (await fireEvent.press(screen.getByText("Schedule a ride"))));
    expect(onClose).toHaveBeenLastCalledWith("schedule");
  });
});
