/**
 * The live map's "waiting for a driver" list, kept in memory: a request
 * offered by dispatch appears with who it was offered to, drivers' answers
 * count, and it goes when the request closes (or is long stale).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../db/prisma";
import { broadcastRide, closeOffer } from "../ride/dispatch";
import { cleanupRide, createTestRide } from "../ride/testFixtures";
import { recordOfferAnswer } from "../stats/rideOffers";
import { noteRequestAnswer, noteRequestClosed, noteRequestOffered, resetLiveRequestsForTests, waitingRequests } from "./liveRequests";

const rideIds: string[] = [];
const base = {
  riderId: "r",
  riderName: "Ama",
  type: "LONE" as const,
  pickup: null,
  pickupZoneId: "z",
  pickupLabel: "Balme Library",
  dropoffLabel: "Akuafo Hall",
};

beforeEach(() => resetLiveRequestsForTests());
afterAll(async () => {
  for (const id of rideIds) await cleanupRide(id);
  await prisma.$disconnect();
});

describe("waiting requests", () => {
  it("adds offers on a re-broadcast, counts answers, and forgets closed and stale requests", () => {
    noteRequestOffered({ ...base, rideId: "a", requestedAt: 1_000 }, ["d1", "d2"], 1_000);
    noteRequestOffered({ ...base, rideId: "a", requestedAt: 1_000 }, ["d2", "d3"], 5_000);
    noteRequestAnswer("a", "d1", "DECLINED", 6_000);
    noteRequestAnswer("a", "d2", "TIMED_OUT", 6_000);
    noteRequestOffered({ ...base, rideId: "b", requestedAt: 500 }, [], 7_000);
    const [b, a] = waitingRequests(8_000);
    expect(b!.rideId).toBe("b");
    expect([...a!.offeredTo].sort()).toEqual(["d1", "d2", "d3"]);
    expect(a!.declinedBy.size).toBe(1);
    expect(a!.timedOutWith.size).toBe(1);
    noteRequestClosed("a");
    expect(waitingRequests(8_000).map((r) => r.rideId)).toEqual(["b"]);
    expect(waitingRequests(7_000 + 16 * 60_000)).toEqual([]);
  });

  it("is fed by dispatch: a broadcast request appears, a decline counts, and closing removes it", async () => {
    const { ride } = await createTestRide({ type: "LONE", status: "REQUESTED" });
    rideIds.push(ride.id);
    await broadcastRide(prisma, ride.id);
    expect(waitingRequests().map((r) => r.rideId)).toContain(ride.id);
    await recordOfferAnswer(prisma, ride.id, "some-driver", "DECLINED");
    expect(waitingRequests().find((r) => r.rideId === ride.id)!.declinedBy.has("some-driver")).toBe(true);
    closeOffer(prisma, ride, "CANCELLED");
    expect(waitingRequests().map((r) => r.rideId)).not.toContain(ride.id);
  });
});
