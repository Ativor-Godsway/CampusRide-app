import { Linking } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DriverScheduledCarView } from "@rida/shared";
// The driver app's real card, and the rider app's Home entry card.
import { ScheduledCarCard, routeSummary } from "../../../../apps/driver/components/schedule/ScheduledCarCard";
import { ScheduleAheadCard } from "../../../../apps/rider/components/schedule/ScheduleAheadCard";

/**
 * The driver's scheduled trip card: the time, total and "you get", Leave by,
 * a route summary, and every rider in stop order with seats, pickup,
 * drop-off (one shared line when all go to the same place) and Call — the
 * same tel: call a trip uses. And the rider's Home "Schedule ahead" card.
 */

jest.mock("../realtime/socket", () => ({
  getRideSocket: () => ({ on: () => {}, off: () => {} }),
  subscribeToRide: jest.fn(),
  unsubscribeFromRide: jest.fn(),
  resetRideSocket: jest.fn(),
}));

const at = (h: number, m = 0) => new Date(Date.UTC(2031, 0, 6, h, m)).toISOString();

const CAR: DriverScheduledCarView = {
  carId: "c1",
  arriveBy: at(9, 30),
  leaveBy: at(9, 8),
  status: "ACCEPTED",
  seats: 3,
  carSeats: 4,
  farePesewas: 2100,
  driverSharePesewas: 1785,
  pickupArea: "Pentagon +1",
  dropoffArea: "Balme Library +1",
  label: "Scheduled · 9:30 AM · 3 seats · GH₵21",
  mine: true,
  canAccept: false,
  note: null,
  riders: [
    { firstName: "Ama", seats: 2, pickupLabel: "Pentagon", dropoffLabel: "Balme Library", coming: true, phone: "+233990000001" },
    { firstName: "Esi", seats: 1, pickupLabel: "TF Hall", dropoffLabel: "JQB", coming: false, phone: "+233990000003" },
  ],
  dropoffOrder: ["JQB", "Balme Library"],
  route: { pickups: 2, dropoffs: 2, meters: 2400 },
  rideId: null,
};

function wrap(node: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
}

describe("the driver's scheduled card", () => {
  it("time, total and you get, Leave by, route summary; riders in stop order with their own drop-offs and Call", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await render(wrap(<ScheduledCarCard car={CAR} source="SCHEDULE" />));
    expect(screen.getByText("9:30 AM")).toBeOnTheScreen();
    expect(screen.getByText("GH₵21")).toBeOnTheScreen();
    expect(screen.getByText("you get GH₵17.85")).toBeOnTheScreen();
    expect(screen.getByText("Leave by 9:08 AM")).toBeOnTheScreen();
    expect(screen.getByText(/2 pickups · 2 drop-offs · 2\.4 km/)).toBeOnTheScreen();
    // Stop order as the server sent it: Ama first, then Esi.
    expect(screen.getByTestId("scheduled-rider-0")).toHaveTextContent(/Ama · 2 seats · coming/);
    expect(screen.getByTestId("scheduled-rider-1")).toHaveTextContent(/Esi/);
    expect(screen.getByText("Drop-off: Balme Library")).toBeOnTheScreen();
    expect(screen.getByText("Drop-off: JQB")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByTestId("call-rider-1"))));
    expect(open).toHaveBeenCalledWith(expect.stringMatching(/^tel:/));
    open.mockRestore();
  });

  it("everyone to the same place: one drop-off line", async () => {
    const same = { ...CAR, riders: CAR.riders.map((r) => ({ ...r, dropoffLabel: "Balme Library" })) };
    await render(wrap(<ScheduledCarCard car={same} source="SCHEDULE" />));
    expect(screen.getByText("All drop-offs: Balme Library")).toBeOnTheScreen();
    expect(screen.queryByText(/^Drop-off:/)).toBeNull();
  });

  it("an open car: from and to, and Accept with the total", async () => {
    await render(wrap(<ScheduledCarCard car={{ ...CAR, mine: false, canAccept: true, riders: [], leaveBy: null }} source="POPUP" />));
    expect(screen.getByText("Accept · GH₵21")).toBeOnTheScreen();
    expect(screen.getByText("Pentagon +1 → Balme Library +1")).toBeOnTheScreen();
    expect(screen.queryByText(/Leave by/)).toBeNull();
    expect(routeSummary(null)).toBeNull();
  });
});

describe("the rider's Home entry", () => {
  it("'Schedule ahead' with its one line", async () => {
    const onPress = jest.fn();
    await render(<ScheduleAheadCard onPress={onPress} />);
    expect(screen.getByText("Schedule ahead")).toBeOnTheScreen();
    expect(screen.getByText("Book your ride to class ahead. Join a car going your way.")).toBeOnTheScreen();
    await act(async () => void (await fireEvent.press(screen.getByTestId("schedule-ahead"))));
    expect(onPress).toHaveBeenCalled();
  });
});
