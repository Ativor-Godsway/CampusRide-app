/**
 * SOS message composition. Pure unit tests — the delivery path and route
 * behaviour are covered in routes/phase4.test.ts.
 */
import { describe, it, expect } from "vitest";
import { SMS_SEGMENT_LIMIT, buildSosMessage } from "./sos";
import { rideStatusLabel } from "./rideStatusLabels";

const BASE = {
  riderName: "Ama Mensah",
  status: "IN_PROGRESS",
  pickupZone: "Legon Hall",
  dropoffZone: "Night Market",
  driverName: "Kofi Owusu",
  plate: "GR-4321-24",
  trackingUrl: "https://campusride-server.onrender.com/track/9f2c1a7b4e8d0c3a5b6e7f8091a2b3c4",
};

describe("rideStatusLabel", () => {
  it("maps internal enums to something a worried parent can read", () => {
    expect(rideStatusLabel("IN_PROGRESS")).toBe("On the trip");
    expect(rideStatusLabel("MATCHED")).toBe("Driver on the way");
    expect(rideStatusLabel("ARRIVED")).toBe("Driver has arrived");
  });

  it("falls back to the raw value rather than rendering blank", () => {
    expect(rideStatusLabel("SOME_NEW_STATUS")).toBe("SOME_NEW_STATUS");
  });
});

describe("buildSosMessage", () => {
  it("leads with SOS and the rider's name, for the notification preview", () => {
    expect(buildSosMessage(BASE).startsWith("SOS: Ama Mensah.")).toBe(true);
  });

  it("uses the human status label, never the raw enum", () => {
    const message = buildSosMessage(BASE);
    expect(message).toContain("On the trip");
    expect(message).not.toContain("IN_PROGRESS");
  });

  it("includes the full route, the plate and the tracking link", () => {
    const message = buildSosMessage(BASE);
    expect(message).toContain("Legon Hall");
    expect(message).toContain("Night Market");
    expect(message).toContain("GR-4321-24");
    expect(message).toContain(BASE.trackingUrl);
  });

  it("gives up the driver's surname before the plate or the route", () => {
    // With a real Render URL eating ~76 of the 160 characters, the full
    // driver name does not fit. The plate identifies the CAR, which is what
    // matters to someone trying to find this rider, so the surname goes
    // first and the route stays intact.
    const message = buildSosMessage(BASE);
    expect(message).toContain("Driver Kofi");
    expect(message).not.toContain("Kofi Owusu");
    expect(message).toContain("GR-4321-24");
    expect(message).toContain("Legon Hall");
  });

  it("keeps the driver's full name when there is room for it", () => {
    const message = buildSosMessage({ ...BASE, trackingUrl: "https://cr.gh/t/abc123" });
    expect(message).toContain("Kofi Owusu");
    expect(message.length).toBeLessThanOrEqual(SMS_SEGMENT_LIMIT);
  });

  it("fits one SMS segment", () => {
    expect(buildSosMessage(BASE).length).toBeLessThanOrEqual(SMS_SEGMENT_LIMIT);
  });

  it("still fits one segment with long names and zones", () => {
    const message = buildSosMessage({
      ...BASE,
      riderName: "Akosua Serwaa Boatemaa Frimpong-Manso",
      pickupZone: "Commonwealth Hall Annex B Junction",
      dropoffZone: "University of Ghana Business School Car Park",
      driverName: "Emmanuel Kwabena Asante-Darko",
    });
    expect(message.length).toBeLessThanOrEqual(SMS_SEGMENT_LIMIT);
    // The link survives truncation — it is the most useful part.
    expect(message).toContain(BASE.trackingUrl);
  });

  it("NEVER truncates the tracking URL, whatever else has to go", () => {
    const longUrl = `https://a-very-long-deployment-hostname.example.com/track/${"a".repeat(32)}`;
    const message = buildSosMessage({ ...BASE, trackingUrl: longUrl });
    expect(message).toContain(longUrl);
  });

  it("keeps the rider's name even when everything else is squeezed", () => {
    const longUrl = `https://an-extremely-long-hostname-for-this-service.example.com/track/${"b".repeat(32)}`;
    const message = buildSosMessage({ ...BASE, trackingUrl: longUrl });
    expect(message).toContain("Ama Mensah");
    expect(message).toContain(longUrl);
  });

  it("says so plainly when no driver is assigned yet", () => {
    const message = buildSosMessage({ ...BASE, driverName: null, plate: null });
    expect(message).toContain("No driver yet");
    expect(message.length).toBeLessThanOrEqual(SMS_SEGMENT_LIMIT);
  });

  it("omits the plate when the driver has none on file", () => {
    const message = buildSosMessage({ ...BASE, plate: null });
    expect(message).toContain("Kofi Owusu");
    expect(message).not.toContain("GR-4321-24");
  });

  it("carries no 'call them' nudge — that belongs on the tracking page", () => {
    // The SMS budget is better spent on the link than on advice.
    expect(buildSosMessage(BASE).toLowerCase()).not.toContain("call");
  });
});
