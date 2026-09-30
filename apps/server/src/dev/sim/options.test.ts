import { describe, expect, it } from "vitest";
import { parseSimOptions, SimOptionError } from "./options";
import { pickDecision, pickDropoffZone, pickPickupZone, pickRideType, planGiveUp } from "./planner";

describe("parseSimOptions", () => {
  it("has the documented defaults", () => {
    const o = parseSimOptions([]);
    expect(o).toMatchObject({ intervalSec: 20, maxOpen: 4, sharedRatio: 0.7, cancelRatio: 0.15, burst: 0, riders: 10, zone: null });
    expect(o.apiUrl).toBe("http://localhost:3000");
  });

  it("reads every flag in both spellings", () => {
    const o = parseSimOptions(["--interval", "5", "--max-open=6", "--shared-ratio", "0.5", "--zone", "Balme Library", "--burst", "5", "--api", "http://192.168.1.5:3000/"]);
    expect(o).toMatchObject({ intervalSec: 5, maxOpen: 6, sharedRatio: 0.5, zone: "Balme Library", burst: 5, apiUrl: "http://192.168.1.5:3000" });
  });

  it("takes the server port from the environment", () => {
    expect(parseSimOptions([], { PORT: "4000" }).apiUrl).toBe("http://localhost:4000");
  });

  it("rejects bad values and unknown flags with a readable error", () => {
    expect(() => parseSimOptions(["--interval", "abc"])).toThrow(SimOptionError);
    expect(() => parseSimOptions(["--shared-ratio", "2"])).toThrow(/between 0 and 1/);
    expect(() => parseSimOptions(["--max-open"])).toThrow(SimOptionError);
    expect(() => parseSimOptions(["--nope"])).toThrow(/Unknown option/);
    expect(() => parseSimOptions(["--burst", "8", "--riders", "4"])).toThrow(/at least that many riders/);
  });
});

const z = (id: string, lat: number) => ({ id, name: id, latitude: lat, longitude: 0 });

describe("planner", () => {
  const home = z("home", 0);
  const near = [z("a", 0.001), z("b", 0.002), z("c", 0.003), z("far", 0.5)];

  it("picks up in the driver's zone or one of the nearest adjacent zones — never far away", () => {
    expect(pickPickupZone(home, near, () => 0.1).id).toBe("home");
    for (const r of [0.61, 0.7, 0.99]) {
      expect(["a", "b", "c"]).toContain(pickPickupZone(home, near, () => r).id);
    }
    expect(pickPickupZone(home, [], () => 0.9).id).toBe("home");
  });

  it("never drops off where it picked up", () => {
    for (const r of [0, 0.5, 0.999]) expect(pickDropoffZone([home, ...near], home, () => r).id).not.toBe("home");
  });

  it("follows the shared ratio", () => {
    expect(pickRideType(0.7, () => 0.69)).toBe("SHARED");
    expect(pickRideType(0.7, () => 0.7)).toBe("LONE");
  });

  it("gives up only sometimes, after 20–60 seconds", () => {
    expect(planGiveUp(0.15, () => 0.5)).toBeNull();
    expect(planGiveUp(0.15, () => 0)).toBe(20_000);
    expect(planGiveUp(1, () => 0.999999)).toBeLessThanOrEqual(60_000);
  });

  it("never switches a Ride alone request to Ride alone", () => {
    for (const r of [0, 0.5, 0.7, 0.99]) expect(pickDecision("LONE", () => r)).not.toBe("SWITCH_TO_LONE");
  });
});
