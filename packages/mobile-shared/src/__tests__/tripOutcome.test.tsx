import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RIDE_EVENTS } from "@rida/shared";
import type { GetRideResult } from "../rides/api";
import { useRideTracking } from "../rides/useRideTracking";
import { isMergedRequest, riderTripOutcome } from "../rides/tripOutcome";

/**
 * The rider's trip screen follows only this rider's own seat (2026-11-05,
 * Bill and Ali sharing one driver):
 *
 * - Bill, added to the car Ali booked, saw "Ride cancelled" mid-trip: his own
 *   request is closed as merged, and the app took the bare CANCELLED event
 *   for that request at its word (and stopped polling);
 * - Bill, dropped off while Ali rode on, waited for the whole car to finish
 *   before his trip ended.
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
}));

/** What GET /rides/:id answers, per ride, as the server has it right now. */
const mockServer = new Map<string, GetRideResult>();
jest.mock("../rides/api", () => ({
  getRide: jest.fn(async (id: string) => {
    const found = mockServer.get(id);
    if (!found) throw new Error(`no ride ${id}`);
    return structuredClone(found);
  }),
}));

const BILL = "bill";
const ALI = "ali";
const FARE = { yourFarePesewas: 700, totalFarePesewas: 1400, paymentMethod: "CASH", paymentStatus: "PENDING" } as const;

function seat(id: string, riderId: string, status: string) {
  return { id, rideId: "car", riderId, pickupZoneId: "z1", dropoffZoneId: "z2", fareCharged: null, lockedFare: 700, status };
}

function ride(id: string, over: Record<string, unknown> = {}, passengers: unknown[] = []): GetRideResult {
  return {
    ride: {
      id,
      riderId: ALI,
      driverId: "driver",
      type: "SHARED",
      status: "MATCHED",
      cancelReason: null,
      mergedIntoRideId: null,
      passengers,
      ...over,
    },
    driver: null,
  } as unknown as GetRideResult;
}

const carWith = (bill: string, ali: string, over: Record<string, unknown> = {}) =>
  ride("car", over, [seat("seat-ali", ALI, ali), seat("seat-bill", BILL, bill)]);

/** Delivers a socket event, then waits a tick: TanStack Query tells components on a setTimeout(0). */
const send = (event: string, payload: unknown) =>
  act(async () => {
    for (const h of mockHandlers.get(event) ?? []) h(payload);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function track(rideId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const rendered = await renderHook(() => useRideTracking(rideId), { wrapper });
  mounted.push(async () => {
    await rendered.unmount();
    client.clear();
  });
  return rendered;
}

const mounted: Array<() => Promise<void>> = [];
beforeEach(() => {
  mockServer.clear();
});
afterEach(async () => {
  while (mounted.length) await mounted.pop()!();
  mockHandlers.clear();
});

describe("riderTripOutcome", () => {
  const outcome = (r: GetRideResult, riderId = BILL) => riderTripOutcome(r, riderId);

  it("goes on while this rider's seat is live, whatever happens to the other seat", () => {
    expect(outcome(carWith("WAITING", "PICKED_UP", { status: "IN_PROGRESS" }))).toBeNull();
    expect(outcome(carWith("ARRIVED", "DROPPED_OFF", { status: "IN_PROGRESS" }))).toBeNull();
    expect(outcome(carWith("PICKED_UP", "CANCELLED", { status: "IN_PROGRESS" }))).toBeNull();
  });

  it("is complete once this rider is dropped off, though the car rides on", () => {
    const r = carWith("DROPPED_OFF", "PICKED_UP", { status: "IN_PROGRESS" });
    expect(outcome(r)).toBe("completed");
    expect(outcome(r, ALI)).toBeNull();
    expect(outcome({ ...carWith("PICKED_UP", "PICKED_UP", { status: "IN_PROGRESS" }), fareSummary: FARE })).toBe("completed");
    expect(outcome(carWith("DROPPED_OFF", "DROPPED_OFF", { status: "COMPLETED" }), ALI)).toBe("completed");
  });

  it("a request merged into a car is not cancelled; a real cancel is", () => {
    const merged = ride("bills-request", {
      riderId: BILL,
      status: "CANCELLED",
      cancelReason: "MERGED_INTO_ANOTHER_RIDE",
      mergedIntoRideId: "car",
    }, [seat("s", BILL, "WAITING")]);
    expect(isMergedRequest(merged.ride)).toBe(true);
    expect(outcome(merged)).toBeNull();

    expect(outcome(ride("r", { riderId: BILL, status: "CANCELLED", cancelReason: "RIDER_CANCELLED" }, [seat("s", BILL, "CANCELLED")]))).toBe(
      "driverCancelled",
    );
    expect(outcome(ride("r", { riderId: BILL, status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE" }, [seat("s", BILL, "WAITING")]))).toBe(
      "cancelled",
    );
    expect(outcome(carWith("CANCELLED", "PICKED_UP", { status: "IN_PROGRESS" }))).toBe("driverCancelled");
  });
});

describe("useRideTracking, Bill's trip screen", () => {
  it("a bare CANCELLED event doesn't end the trip: the server's answer (merged into a car) does", async () => {
    mockServer.set("bills-request", ride("bills-request", { riderId: BILL, status: "REQUESTED", driverId: null }, [seat("s", BILL, "WAITING")]));
    const { result } = await track("bills-request");
    await waitFor(() => expect(result.current.data?.ride.status).toBe("REQUESTED"));

    // The driver adds Bill to Ali's car. An older server says only "CANCELLED".
    mockServer.set(
      "bills-request",
      ride("bills-request", { riderId: BILL, status: "CANCELLED", cancelReason: "MERGED_INTO_ANOTHER_RIDE", mergedIntoRideId: "car" }, [
        seat("s", BILL, "WAITING"),
      ]),
    );
    await send(RIDE_EVENTS.STATUS, { rideId: "bills-request", status: "CANCELLED" });
    // Was: "cancelled" at once, and the poll stopped.
    expect(riderTripOutcome(result.current.data, BILL)).toBeNull();
    await waitFor(() => expect(result.current.data?.ride.mergedIntoRideId).toBe("car"));
    expect(isMergedRequest(result.current.data!.ride)).toBe(true);
    expect(riderTripOutcome(result.current.data, BILL)).toBeNull();
  });

  it("a CANCELLED event that says where the car is is followed at once", async () => {
    mockServer.set("bills-request", ride("bills-request", { riderId: BILL, status: "REQUESTED", driverId: null }, [seat("s", BILL, "WAITING")]));
    const { result } = await track("bills-request");
    await waitFor(() => expect(result.current.data).toBeDefined());
    mockServer.set(
      "bills-request",
      ride("bills-request", { riderId: BILL, status: "CANCELLED", cancelReason: "MERGED_INTO_ANOTHER_RIDE", mergedIntoRideId: "car" }, [
        seat("s", BILL, "WAITING"),
      ]),
    );
    await send(RIDE_EVENTS.STATUS, {
      rideId: "bills-request",
      status: "CANCELLED",
      cancelReason: "MERGED_INTO_ANOTHER_RIDE",
      mergedIntoRideId: "car",
    });
    expect(isMergedRequest(result.current.data!.ride)).toBe(true);
    expect(riderTripOutcome(result.current.data, BILL)).toBeNull();
  });

  it("Ali picked up: the car moves off, Bill's own seat and trip are untouched", async () => {
    mockServer.set("car", carWith("ARRIVED", "ARRIVED", { status: "ARRIVED" }));
    const { result } = await track("car");
    await waitFor(() => expect(result.current.data).toBeDefined());

    mockServer.set("car", carWith("ARRIVED", "PICKED_UP", { status: "IN_PROGRESS" }));
    await send(RIDE_EVENTS.STATUS, { rideId: "car", status: "IN_PROGRESS" });
    // Ali's own event reaches only Ali's phone; were one to arrive here, it
    // names Ali's seat, which Bill's screen never applies to his own.
    await send(RIDE_EVENTS.PASSENGER_STATUS, { rideId: "car", ridePassengerId: "seat-ali", riderId: ALI, status: "PICKED_UP" });

    const mySeat = result.current.data!.ride.passengers.find((p) => p.riderId === BILL);
    expect(result.current.data!.ride.status).toBe("IN_PROGRESS");
    expect(mySeat?.status).toBe("ARRIVED");
    expect(riderTripOutcome(result.current.data, BILL)).toBeNull();
  });

  it("Bill dropped off while Ali rides on: his trip is complete with his fare", async () => {
    mockServer.set("car", carWith("PICKED_UP", "PICKED_UP", { status: "IN_PROGRESS" }));
    const { result } = await track("car");
    await waitFor(() => expect(result.current.data).toBeDefined());

    mockServer.set("car", { ...carWith("DROPPED_OFF", "PICKED_UP", { status: "IN_PROGRESS" }), fareSummary: FARE });
    await send(RIDE_EVENTS.PASSENGER_STATUS, { rideId: "car", ridePassengerId: "seat-bill", riderId: BILL, status: "DROPPED_OFF" });
    expect(riderTripOutcome(result.current.data, BILL)).toBe("completed");

    await send(RIDE_EVENTS.COMPLETED, { rideId: "car", fareSummary: FARE });
    expect(result.current.data!.fareSummary).toEqual(FARE);
    // The car itself is still on its way with Ali.
    await waitFor(() => expect(result.current.data!.ride.status).toBe("IN_PROGRESS"));
    expect(riderTripOutcome(result.current.data, BILL)).toBe("completed");
  });

  it("a real cancel still ends with Ride cancelled, once the server confirms it", async () => {
    mockServer.set("r", ride("r", { riderId: BILL, status: "REQUESTED", driverId: null }, [seat("s", BILL, "WAITING")]));
    const { result } = await track("r");
    await waitFor(() => expect(result.current.data).toBeDefined());

    mockServer.set("r", ride("r", { riderId: BILL, status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE" }, [seat("s", BILL, "WAITING")]));
    await send(RIDE_EVENTS.STATUS, { rideId: "r", status: "CANCELLED" });
    await waitFor(() => expect(riderTripOutcome(result.current.data, BILL)).toBe("cancelled"));
  });
});
