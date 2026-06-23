import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../../db/prisma";
import { handleUssdRequest, type MoolreUssdRequest } from "./ussdHandler";

let counter = 0;
/** A unique, valid (per lib/phone.ts) 233-format msisdn for each test. */
function testMsisdn(): string {
  counter += 1;
  return `23320${String(Date.now()).slice(-6)}${counter}`;
}

const createdUserIds: string[] = [];
const createdRideIds: string[] = [];
let sessionCounter = 0;
function testSessionId(): string {
  sessionCounter += 1;
  return `test-session-${Date.now()}-${sessionCounter}`;
}

afterEach(async () => {
  while (createdRideIds.length > 0) {
    await prisma.ride.deleteMany({ where: { id: createdRideIds.pop()! } });
  }
  while (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: createdUserIds.pop()! } });
  }
});

function newRequest(sessionId: string, msisdn: string): MoolreUssdRequest {
  return { sessionId, new: true, msisdn, message: "" };
}

function continueRequest(sessionId: string, msisdn: string, message: string): MoolreUssdRequest {
  return { sessionId, new: false, msisdn, message };
}

/** Walks a fresh session from MAIN through to CONFIRM (ride type SHARED), returning the session id and msisdn used. */
async function walkToConfirm(msisdn: string) {
  const sessionId = testSessionId();
  await handleUssdRequest(prisma, newRequest(sessionId, msisdn));
  await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // Request a ride
  await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // pickup group: Halls
  await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // pickup zone: Legon Hall
  await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "2")); // dropoff group: Academic
  await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // dropoff zone: School of Business
  const rideTypeRes = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // Shared
  return { sessionId, rideTypeRes };
}

describe("handleUssdRequest", () => {
  it("returns the main menu on a fresh session", async () => {
    const res = await handleUssdRequest(prisma, newRequest(testSessionId(), testMsisdn()));
    expect(res.reply).toBe(true);
    expect(res.message).toContain("1. Request a ride");
    expect(res.message).toContain("2. Check ride status");
    expect(res.message).toContain("3. Make payment");
  });

  it("resets to the main menu for an unknown sessionId on a continuing request", async () => {
    const res = await handleUssdRequest(
      prisma,
      continueRequest("never-started", testMsisdn(), "1"),
    );
    expect(res.reply).toBe(true);
    expect(res.message).toContain("1. Request a ride");
  });

  it("re-prompts the same menu on an invalid choice instead of crashing", async () => {
    const sessionId = testSessionId();
    const msisdn = testMsisdn();
    await handleUssdRequest(prisma, newRequest(sessionId, msisdn));
    const res = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "9"));
    expect(res.reply).toBe(true);
    expect(res.message).toContain("Invalid choice.");
    expect(res.message).toContain("1. Request a ride");
  });

  it("walks pickup group -> pickup zone -> dropoff group -> dropoff zone -> ride type -> confirm", async () => {
    const msisdn = testMsisdn();
    const { rideTypeRes } = await walkToConfirm(msisdn);
    expect(rideTypeRes.reply).toBe(true);
    expect(rideTypeRes.message).toContain("Confirm ride:");
    expect(rideTypeRes.message).toContain("From: Legon Hall");
    expect(rideTypeRes.message).toContain("To: School of Business");
    expect(rideTypeRes.message).toContain("Shared");
  });

  it("creates a USSD-sourced ride on confirm and ends the session", async () => {
    const msisdn = testMsisdn();
    const { sessionId } = await walkToConfirm(msisdn);

    const res = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1"));
    expect(res.reply).toBe(false);
    expect(res.message).toContain("Request sent!");

    const phone = `+${msisdn}`;
    const user = await prisma.user.findUnique({ where: { phone } });
    expect(user).not.toBeNull();
    createdUserIds.push(user!.id);

    const ride = await prisma.ride.findFirst({ where: { riderId: user!.id } });
    expect(ride).not.toBeNull();
    expect(ride!.source).toBe("USSD");
    expect(ride!.type).toBe("SHARED");
    createdRideIds.push(ride!.id);

    // Session must be cleared — replaying the same sessionId now resets to MAIN.
    const replay = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1"));
    expect(replay.message).toContain("1. Request a ride");
  });

  it("ends gracefully (does not throw) when the msisdn fails phone normalization", async () => {
    const sessionId = testSessionId();
    const badMsisdn = "not-a-phone";
    await handleUssdRequest(prisma, newRequest(sessionId, badMsisdn));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "2"));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));
    await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));

    const res = await handleUssdRequest(prisma, continueRequest(sessionId, badMsisdn, "1"));
    expect(res.reply).toBe(false);
    expect(res.message).toContain("couldn't process your phone number");

    const user = await prisma.user.findFirst({ where: { phone: { contains: "not-a-phone" } } });
    expect(user).toBeNull();
  });

  it("rejects picking the same zone for pickup and dropoff, re-prompting dropoff zone", async () => {
    const sessionId = testSessionId();
    const msisdn = testMsisdn();
    await handleUssdRequest(prisma, newRequest(sessionId, msisdn));
    await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1"));
    await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // pickup group: Halls
    await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // pickup zone: Legon Hall
    await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // dropoff group: Halls (same group)
    const res = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // dropoff zone: Legon Hall (same as pickup)

    expect(res.reply).toBe(true);
    expect(res.message).toContain("can't be the same zone");
  });

  it("check ride status: no active ride", async () => {
    const sessionId = testSessionId();
    const msisdn = testMsisdn();
    await handleUssdRequest(prisma, newRequest(sessionId, msisdn));
    const res = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "2"));
    expect(res.reply).toBe(false);
    expect(res.message).toBe("You have no active ride.");
  });

  it("check ride status: reports REQUESTED status text for an active ride", async () => {
    const msisdn = testMsisdn();
    const { sessionId } = await walkToConfirm(msisdn);
    await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "1")); // confirm -> creates ride

    const phone = `+${msisdn}`;
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
    createdUserIds.push(user.id);
    const ride = await prisma.ride.findFirstOrThrow({ where: { riderId: user.id } });
    createdRideIds.push(ride.id);

    const statusSessionId = testSessionId();
    await handleUssdRequest(prisma, newRequest(statusSessionId, msisdn));
    const res = await handleUssdRequest(prisma, continueRequest(statusSessionId, msisdn, "2"));
    expect(res.reply).toBe(false);
    expect(res.message).toContain("Looking for a driver");
  });

  it("shows the dummy payment screen and ends the session", async () => {
    const sessionId = testSessionId();
    const msisdn = testMsisdn();
    await handleUssdRequest(prisma, newRequest(sessionId, msisdn));
    const res = await handleUssdRequest(prisma, continueRequest(sessionId, msisdn, "3"));
    expect(res.reply).toBe(false);
    expect(res.message).toContain("demo");
  });
});
