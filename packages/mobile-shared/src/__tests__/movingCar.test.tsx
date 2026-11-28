import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { RiderAddedPayload } from "@rida/shared";
import { rebookIsSilent } from "../rides/tripOutcome";
// The apps' real components.
import { RiderAddedBanner } from "../../../../apps/driver/components/trip/RiderAddedBanner";
import { JoinedCarCard } from "../../../../apps/rider/components/ride/JoinedCarCard";
import { AddRiderTakeover } from "../../../../apps/driver/components/trip/AddRiderTakeover";

/**
 * Fill moving cars first, in the apps: the driver's "Rider added" banner with
 * Undo for 15 s; the bigger on-trip offer ("On your way" and "+GH₵7 · +3 min
 * · Pentagon Block C → JQB"); the rider's "You've joined Kofi's car"; and an
 * undone add that just carries on searching (no "driver had to cancel").
 */

jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({ on: () => {}, off: () => {} }),
  subscribeToRide: jest.fn(),
  unsubscribeFromRide: jest.fn(),
  resetRideSocket: jest.fn(),
}));
jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({ play: jest.fn(), seekTo: jest.fn(async () => undefined), volume: 1 })),
  setAudioModeAsync: jest.fn(async () => undefined),
}));
jest.mock("../maps/CampusMapView", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  const React = jest.requireActual<typeof import("react")>("react");
  return { ...jest.requireActual<object>("../maps/CampusMapView"), CampusMapView: () => React.createElement(View, { testID: "map" }) };
});

const ADDED: RiderAddedPayload = {
  rideId: "car1",
  passengerId: "seat1",
  text: "Rider added · Ama · Pentagon Block C · 2 seats · +GH₵14 · +3 min",
  firstName: "Ama",
  pickupLabel: "Pentagon Block C",
  dropoffLabel: "JQB",
  seats: 2,
  farePesewas: 1400,
  extraMinutes: 2.6,
  undoUntil: Date.now() + 15_000,
};

const safe = (node: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } }}>{node}</SafeAreaProvider>
);

describe("the driver's Rider added banner", () => {
  it("says who, where, seats, money and time; Undo counts down 15 s", async () => {
    const onUndo = jest.fn();
    await render(<RiderAddedBanner added={ADDED} undoing={false} onUndo={onUndo} onDone={() => {}} />);
    expect(screen.getByText("Rider added · Ama")).toBeOnTheScreen();
    expect(screen.getByText("Pentagon Block C · 2 seats · +GH₵14 · +3 min")).toBeOnTheScreen();
    expect(screen.getByText(/^Undo 1[45]$/)).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByTestId("undo-auto-add"))));
    expect(onUndo).toHaveBeenCalled();
  });

  it("closes itself when the 15 s are up", async () => {
    jest.useFakeTimers();
    const onDone = jest.fn();
    await render(<RiderAddedBanner added={{ ...ADDED, undoUntil: Date.now() + 1_000 }} undoing={false} onUndo={() => {}} onDone={onDone} />);
    await act(async () => void jest.advanceTimersByTime(1_500));
    expect(onDone).toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe("the on-trip offer while auto-add is off", () => {
  it("'On your way' with '+GH₵7 · +3 min · Pentagon Block C → JQB' and one big Add", async () => {
    const onAdd = jest.fn();
    await render(
      safe(
        <AddRiderTakeover
          suggestion={{
            requestRideId: "r1",
            riderFirstName: "Esi",
            pickupZoneName: "Pentagon",
            pickupZoneId: "z1",
            dropoffZoneName: "JQB",
            dropoffZoneId: "z2",
            pickupPlaceName: "Pentagon Block C",
            dropoffPlaceName: "JQB",
            createdAt: new Date().toISOString(),
            compatible: true,
            farePesewas: 700,
            seats: 1,
            movingOffer: { until: new Date(Date.now() + 20_000).toISOString(), extraMinutes: 3 },
          }}
          preview={undefined}
          car={null}
          zones={new Map()}
          path={[]}
          countdown={null}
          sharedFarePesewas={700}
          freeSeats={2}
          movingOffer={{ until: new Date(Date.now() + 20_000).toISOString(), extraMinutes: 3 }}
          committing={false}
          onAdd={onAdd}
          onDecline={() => {}}
        />,
      ),
    );
    expect(screen.getByText(/On your way · add this rider/i)).toBeOnTheScreen();
    expect(screen.getByText("+GH₵7 · +3 min · Pentagon Block C → JQB")).toBeOnTheScreen();
    expect(screen.getByText("Add")).toBeOnTheScreen();
  });
});

describe("the rider", () => {
  it("'You've joined Kofi's car, already on the way. Pickup in about 4 min', with the car", async () => {
    await render(
      <JoinedCarCard
        driver={{ name: "Kofi Mensah", carColor: "Silver", carMake: "Toyota", carModel: "Vitz", plate: "GT 1234-24" }}
        pickupEtaMinutes={4}
        top={100}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("You've joined Kofi's car, already on the way. Pickup in about 4 min")).toBeOnTheScreen();
    expect(screen.getByText("Silver Toyota Vitz · GT 1234-24")).toBeOnTheScreen();
  });

  it("an undone add carries on searching silently; a real driver cancel still says so", () => {
    expect(rebookIsSilent({ undone: true })).toBe(true);
    expect(rebookIsSilent({})).toBe(false);
    expect(rebookIsSilent(undefined)).toBe(false);
  });
});
