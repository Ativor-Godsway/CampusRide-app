import { describe, expect, it } from "vitest";
import { maskPayload, maskPhone, maskPlate, personLabel } from "./investor";

describe("investor view masking", () => {
  it("masks phone numbers and plates", () => {
    expect(maskPhone("+233541234546")).toBe("054 *** **46");
    expect(maskPhone("0241234567")).toBe("024 *** **67");
    expect(maskPhone("+233*****146")).toBe("0** *** **46");
    expect(maskPlate("GT 4821-22")).toBe("GT •••• ••");
  });

  it("gives the same id the same label, by kind", () => {
    expect(personLabel("rider", "user-1")).toBe(personLabel("rider", "user-1"));
    expect(personLabel("rider", "user-1")).toMatch(/^Rider #\d{4}$/);
    expect(personLabel("driver", "user-2")).toMatch(/^Driver D\d{3}$/);
    expect(personLabel("admin", "x")).toBe("Admin");
  });

  it("masks every person in a ride row, keeps places, zones and numbers", () => {
    const row = {
      id: "ride-1",
      fareTotal: 700,
      pickup: "Night Market",
      pickupZone: { id: "z1", name: "Central" },
      rider: { id: "u-ama", name: "Ama Owusu", maskedPhone: "+233*****146" },
      driver: { id: "u-kofi", driverId: "d-kofi", name: "Kofi Mensah", plate: "GT 4821-22" },
    };
    const masked = maskPayload(row);
    expect(masked.rider.name).toBe(personLabel("rider", "u-ama"));
    expect(masked.rider.maskedPhone).toBe("0** *** **46");
    expect(masked.driver.name).toBe(personLabel("driver", "u-kofi"));
    expect(masked.driver.plate).toBe("GT •••• ••");
    expect(masked.pickupZone.name).toBe("Central");
    expect(masked.pickup).toBe("Night Market");
    expect(masked.fareTotal).toBe(700);
    expect(JSON.stringify(masked)).not.toMatch(/Ama|Kofi|4821/);
  });

  it("replaces known names inside sentences, and phone numbers in text", () => {
    const detail = {
      ride: { rider: { id: "u-ama", name: "Ama Owusu" }, driver: { id: "u-kofi", name: "Kofi Mensah", plate: "GR 1-20" } },
      timeline: [
        { kind: "requested", text: "Ama Owusu asked for a shared ride" },
        { kind: "offer", text: "Offered to Kofi Mensah: accepted in 4 s" },
        { kind: "note", text: "Called 0241234567 about the pickup" },
      ],
      mergedRides: [{ id: "r2", riderName: "Yaw Boateng" }],
    };
    const m = maskPayload(detail);
    expect(m.timeline[0]!.text).toBe(`${personLabel("rider", "u-ama")} asked for a shared ride`);
    expect(m.timeline[1]!.text).toContain(personLabel("driver", "u-kofi"));
    expect(m.timeline[2]!.text).toBe("Called 024 *** **67 about the pickup");
    expect(m.mergedRides[0]!.riderName).toMatch(/^Rider #/);
    expect(JSON.stringify(m)).not.toMatch(/Ama|Kofi|Yaw/);
  });

  it("masks lists of drivers and riders, admins, search results; keeps Paystack", () => {
    const body = {
      drivers: [{ driverId: "d1", userId: "u1", name: "Esi Driver", maskedPhone: "+233*****222", plate: "AS 22-21", isApproved: true, photoUrl: "https://x" }],
      list: [{ id: "u2", name: "Kwame Rider", maskedPhone: "+233*****333", joinedAt: "2026-11-23T00:00:00Z" }],
      entries: [{ actor: { id: "a1", name: "Owner Name" }, reason: "Approved Esi Driver" }],
      results: [{ kind: "rider", id: "u2", title: "Kwame Rider", subtitle: "+233*****333" }],
      ledger: [{ recordedBy: "Paystack" }, { recordedBy: "Owner Name" }],
      places: [{ id: "p1", name: "Balme Library", latitude: 5.65, longitude: -0.18 }],
    };
    const m = maskPayload(body);
    expect(m.drivers[0]!.name).toMatch(/^Driver D/);
    expect(m.drivers[0]!.photoUrl).toBeNull();
    expect(m.list[0]!.name).toMatch(/^Rider #/);
    expect(m.entries[0]!.actor.name).toBe("Admin");
    expect(m.entries[0]!.reason).toMatch(/^Approved Driver D\d{3}$/);
    expect(m.results[0]!.title).toBe(m.list[0]!.name);
    expect(m.ledger.map((l) => l.recordedBy)).toEqual(["Paystack", "Admin"]);
    expect(m.places[0]!.name).toBe("Balme Library");
  });
});
