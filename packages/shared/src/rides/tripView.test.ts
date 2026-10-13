/**
 * The driver's trip screen, step by step, as on the phone on 2026-10-13:
 * optimistic steps on top of the server's trip, refetches arriving late or
 * early, a refused step, and the end of the trip. Each step asks the same
 * question the screen does: what is the NEXT STOP, and how many seats are
 * taken?
 */
import { describe, expect, it } from "vitest";
import type { PassengerStatus } from "../types/ride";
import { planTripStops, type TripZone } from "./tripStops";
import {
  applySeatOverlays,
  chooseTripSource,
  settleSeatOverlays,
  summaryGivesWay,
  type ClaimState,
  type SeatOverlay,
} from "./tripView";

const zone = (id: string, i: number): TripZone => ({ id, name: id, latitude: 5.64 + i * 0.002, longitude: -0.187 });
const zones = new Map(
  [zone("Balme", 0), zone("Chemistry", 1), zone("Police", 2), zone("Annex", 3), zone("Night", 4), zone("Volta", 5)].map((z) => [z.id, z]),
);

interface Seat {
  id: string;
  riderName: string;
  pickupZoneId: string;
  dropoffZoneId: string;
  lockedFare: number;
  status: PassengerStatus;
}

/** A tiny trip screen: the server's trip, this device's overlays, the accept. */
function screen() {
  let server: Seat[] | null = null;
  let overlays: Readonly<Record<string, SeatOverlay>> = {};
  let claimState: ClaimState | null = "sending";
  let serverSeen = false;
  /** The driver is where they last stopped (starts at Balme). */
  let at: { latitude: number; longitude: number } = zones.get("Balme")!;
  const provisional: Seat = {
    id: "claim:r1",
    riderName: "Ama Test",
    pickupZoneId: "Balme",
    dropoffZoneId: "Police",
    lockedFare: 500,
    status: "WAITING",
  };

  const view = () => {
    const source = chooseTripSource({ hasServerRide: server !== null, claimState, serverSeen });
    const seats =
      source === "server" ? applySeatOverlays(server!, overlays) : source === "provisional" ? applySeatOverlays([provisional], overlays) : [];
    const plan = planTripStops({ passengers: seats, zones, from: at });
    const next = plan.upcoming[0];
    return {
      source,
      next: next ? `${next.kind === "PICKUP" ? "Pick up" : "Drop off"} ${next.riderFirstName} at ${next.zone.name}` : null,
      seatsTaken: seats.filter((p) => p.status === "WAITING" || p.status === "ARRIVED" || p.status === "PICKED_UP").length,
      upcoming: plan.upcoming.length,
      summaryGivesWay: summaryGivesWay({ source, upcomingStops: plan.upcoming.length }),
    };
  };

  return {
    view,
    /** The server answers the accept and lists the trip. */
    serverLists(seats: Seat[]) {
      server = seats.map((s) => ({ ...s }));
      if (claimState === "sending") claimState = "confirmed";
      serverSeen = true;
      overlays = settleSeatOverlays(overlays, server);
    },
    /** A refetch: the server's view (may be older than this device's steps). */
    refetch(statuses: Record<string, PassengerStatus> | null) {
      if (statuses === null) {
        server = null; // the trip is over: the server no longer lists it
        return;
      }
      server = server!.map((s) => ({ ...s, status: statuses[s.id] ?? s.status }));
      overlays = settleSeatOverlays(overlays, server);
    },
    /** The driver slides at that rider's stop: the screen moves at once. */
    step(id: string, status: PassengerStatus) {
      overlays = { ...overlays, [id]: { status } };
      const seat = [...(server ?? []), provisional].find((p) => p.id === id);
      if (seat) at = zones.get(status === "DROPPED_OFF" ? seat.dropoffZoneId : seat.pickupZoneId)!;
    },
    /** The server refused that step: the overlay goes, the refetch shows the truth. */
    refused(id: string) {
      const { [id]: _gone, ...rest } = overlays;
      overlays = rest;
    },
    addSeat(seat: Seat) {
      server = [...server!, seat];
    },
  };
}

const A: Seat = { id: "a", riderName: "Ama Test", pickupZoneId: "Balme", dropoffZoneId: "Police", lockedFare: 500, status: "WAITING" };
const B: Seat = { id: "b", riderName: "Kofi Test", pickupZoneId: "Chemistry", dropoffZoneId: "Annex", lockedFare: 500, status: "WAITING" };
const C: Seat = { id: "c", riderName: "Esi Test", pickupZoneId: "Night", dropoffZoneId: "Volta", lockedFare: 500, status: "WAITING" };

describe("the trip screen through a shared trip", () => {
  it("two riders: pick up A, pick up B, drop A, drop B — then Trip complete, never back to A's pickup", () => {
    const s = screen();
    expect(s.view()).toMatchObject({ source: "provisional", next: "Pick up Ama at Balme", seatsTaken: 1 });
    s.serverLists([A, B]);
    expect(s.view()).toMatchObject({ source: "server", next: "Pick up Ama at Balme", seatsTaken: 2 });

    s.step("a", "ARRIVED");
    s.step("a", "PICKED_UP");
    expect(s.view().next).toBe("Pick up Kofi at Chemistry");
    // A refetch from BEFORE that step lands late: the screen doesn't go back.
    s.refetch({ a: "ARRIVED" });
    expect(s.view().next).toBe("Pick up Kofi at Chemistry");

    s.step("b", "PICKED_UP");
    s.refetch({ a: "PICKED_UP", b: "PICKED_UP" });
    expect(s.view()).toMatchObject({ next: "Drop off Ama at Police", seatsTaken: 2 });

    s.step("a", "DROPPED_OFF");
    expect(s.view()).toMatchObject({ next: "Drop off Kofi at Annex", seatsTaken: 1 });
    s.step("b", "DROPPED_OFF");
    expect(s.view()).toMatchObject({ next: null, seatsTaken: 0, upcoming: 0 });

    // The server completes the trip and stops listing it. THE BUG: the screen
    // used to fall back to the provisional trip ("Pick up … at Balme", 1 seat)
    // and drop the Trip complete screen. Now: nothing to show, summary stays.
    s.refetch(null);
    expect(s.view()).toMatchObject({ source: "none", next: null, upcoming: 0, summaryGivesWay: false });
  });

  it("the same with a rider added mid-trip in between", () => {
    const s = screen();
    s.serverLists([A, B]);
    s.step("a", "PICKED_UP");
    s.step("b", "PICKED_UP");
    s.refetch({ a: "PICKED_UP", b: "PICKED_UP" });

    // Esi is added while driving: her pickup slots in, seats go to 3.
    s.addSeat(C);
    expect(s.view().seatsTaken).toBe(3);
    expect(s.view().next).toMatch(/^(Pick up Esi at Night|Drop off (Ama|Kofi) at (Police|Annex))$/);

    s.step("a", "DROPPED_OFF");
    s.step("c", "PICKED_UP");
    s.step("b", "DROPPED_OFF");
    expect(s.view()).toMatchObject({ next: "Drop off Esi at Volta", seatsTaken: 1 });
    s.refetch({ a: "DROPPED_OFF", b: "DROPPED_OFF", c: "PICKED_UP" });
    s.step("c", "DROPPED_OFF");
    expect(s.view()).toMatchObject({ next: null, upcoming: 0 });
    s.refetch(null);
    expect(s.view()).toMatchObject({ source: "none", next: null, summaryGivesWay: false });
  });

  it("a refused step recovers from the server: the screen shows the real next stop", () => {
    const s = screen();
    s.serverLists([A, B]);
    s.step("a", "PICKED_UP");
    s.step("b", "PICKED_UP");
    s.refetch({ a: "PICKED_UP", b: "PICKED_UP" });

    // On another path the server already has Ama dropped off; the device
    // still thinks she's to be dropped off and slides — "This rider has
    // already been dropped off." The overlay goes and the refetch wins.
    s.step("a", "DROPPED_OFF");
    s.refused("a");
    s.refetch({ a: "DROPPED_OFF" });
    expect(s.view()).toMatchObject({ next: "Drop off Kofi at Annex", seatsTaken: 1 });

    // A refused pickup on a rider who cancelled: they leave the stop list.
    const t = screen();
    t.serverLists([A, B]);
    t.step("b", "PICKED_UP");
    t.refused("b");
    t.refetch({ b: "CANCELLED" });
    expect(t.view()).toMatchObject({ next: "Pick up Ama at Balme", seatsTaken: 1 });
  });

  it("the server being ahead of the device (a step taken elsewhere) is shown at once", () => {
    const s = screen();
    s.serverLists([A, B]);
    s.step("a", "ARRIVED");
    s.refetch({ a: "PICKED_UP" });
    expect(s.view().next).toBe("Pick up Kofi at Chemistry");
  });
});

describe("chooseTripSource", () => {
  it("shows the provisional trip only until the server has listed it", () => {
    expect(chooseTripSource({ hasServerRide: true, claimState: "confirmed", serverSeen: true })).toBe("server");
    expect(chooseTripSource({ hasServerRide: false, claimState: "sending", serverSeen: false })).toBe("provisional");
    expect(chooseTripSource({ hasServerRide: false, claimState: "confirmed", serverSeen: false })).toBe("provisional");
    // The trip ended (the server had it, and now doesn't): never provisional again.
    expect(chooseTripSource({ hasServerRide: false, claimState: "confirmed", serverSeen: true })).toBe("none");
    expect(chooseTripSource({ hasServerRide: false, claimState: "refused", serverSeen: false })).toBe("none");
    expect(chooseTripSource({ hasServerRide: false, claimState: null, serverSeen: false })).toBe("none");
  });

  it("Trip complete gives way only to the server's own trip with stops left (a refused drop-off)", () => {
    expect(summaryGivesWay({ source: "server", upcomingStops: 1 })).toBe(true);
    expect(summaryGivesWay({ source: "server", upcomingStops: 0 })).toBe(false);
    expect(summaryGivesWay({ source: "provisional", upcomingStops: 1 })).toBe(false);
    expect(summaryGivesWay({ source: "none", upcomingStops: 0 })).toBe(false);
  });
});

describe("seat overlays", () => {
  it("never move a seat backwards, and settle once the server catches up", () => {
    const seats = [{ id: "a", status: "PICKED_UP" as PassengerStatus }];
    expect(applySeatOverlays(seats, { a: { status: "ARRIVED" } })[0]!.status).toBe("PICKED_UP");
    expect(applySeatOverlays(seats, { a: { status: "DROPPED_OFF" } })[0]!.status).toBe("DROPPED_OFF");
    const overlays = { a: { status: "PICKED_UP" as PassengerStatus } };
    expect(settleSeatOverlays(overlays, seats)).toEqual({});
    expect(settleSeatOverlays(overlays, [{ id: "a", status: "WAITING" }])).toBe(overlays);
  });
});
