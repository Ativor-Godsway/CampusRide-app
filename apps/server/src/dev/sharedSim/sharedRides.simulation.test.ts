/**
 * Whole shared-ride trips against a real local server and real Socket.io
 * clients (the test database, never production): the dispatch rules of
 * services/ride/requestFit.ts as drivers' and riders' phones see them. The
 * scenarios themselves are in ./scenarios.ts, shared with
 * `npm run simulate:shared`, which prints the same timeline.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../db/prisma";
import { resetLivePositionsForTests } from "../../services/zones/livePositions";
import { scheduleRequestExpiry } from "../../services/ride/timeouts";
import { SCENARIOS } from "./scenarios";
import { World } from "./world";

vi.mock("../../services/sms/sendSms", () => ({ sendSms: vi.fn().mockResolvedValue({ success: true }) }));

let world: World;

beforeAll(async () => {
  world = new World(prisma);
  await world.start();
});

afterEach(async () => {
  await world.cleanup();
  resetLivePositionsForTests();
});

afterAll(async () => {
  await world.stop();
});

describe("shared-ride simulation", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.key}) ${scenario.title}`, async () => {
      world.heading(`${scenario.key}) ${scenario.title}`);
      await scenario.run(world);
    });
  }
});

describe("the search ends exactly when its window does", () => {
  it("not at the next sweep: the rider gets 'no drivers' straight away", async () => {
    const rider = await world.rider("Rider 1");
    const id = await rider.request("SHARED");
    // Make it 90 s old, then let the request's own timer run (as broadcastRide sets it).
    const started = new Date(Date.now() - 90_000);
    await prisma.ride.update({ where: { id }, data: { broadcastStartedAt: started } });
    scheduleRequestExpiry(prisma, id, started);
    await vi.waitFor(async () => expect(await rider.screen()).toBe("no drivers"), { timeout: 5_000 });
  });
});
