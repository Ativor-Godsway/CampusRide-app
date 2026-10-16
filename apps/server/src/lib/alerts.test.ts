import { afterEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { prisma } from "../db/prisma";
import { authenticateSocket } from "../realtime/rideSocket";
import {
  resetPushStateForTests,
  sendPush,
  setPushTransportForTests,
} from "../services/push/pushService";
import { alerts, isDatabaseConnectionError, noteDatabaseError, ThresholdAlert } from "./alerts";

const MINUTE = 60_000;

function alertWithClock(threshold = 3) {
  let now = 0;
  const report = vi.fn();
  const alert = new ThresholdAlert({
    kind: "test",
    message: "Things are failing",
    threshold,
    windowMs: 5 * MINUTE,
    cooldownMs: 30 * MINUTE,
    now: () => now,
    report,
  });
  return { alert, report, advance: (ms: number) => (now += ms) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const alert of Object.values(alerts)) alert.reset();
});

describe("ThresholdAlert", () => {
  it("reports once the threshold is reached inside the window", () => {
    const { alert, report } = alertWithClock();
    expect(alert.record()).toBe(false);
    expect(alert.record()).toBe(false);
    expect(alert.record({ where: "x" })).toBe(true);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("Things are failing (3 in 5 min)", {
      level: "error",
      tags: { alert: "test" },
      extra: { where: "x", count: 3, windowMinutes: 5 },
    });
  });

  it("forgets failures older than the window", () => {
    const { alert, report, advance } = alertWithClock();
    alert.record();
    alert.record();
    advance(6 * MINUTE);
    expect(alert.record()).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it("stays quiet for the cooldown, then reports again", () => {
    const { alert, report, advance } = alertWithClock(1);
    alert.record();
    advance(10 * MINUTE);
    alert.record();
    expect(report).toHaveBeenCalledOnce();
    advance(25 * MINUTE);
    alert.record();
    expect(report).toHaveBeenCalledTimes(2);
  });
});

describe("database connection failures", () => {
  const prismaError = (name: string, code?: string, message = "x") =>
    Object.assign(new Error(message), { name, ...(code ? { code } : {}) });

  it("recognises connection failures and nothing else", () => {
    expect(isDatabaseConnectionError(prismaError("PrismaClientInitializationError"))).toBe(true);
    expect(isDatabaseConnectionError(prismaError("PrismaClientKnownRequestError", "P1001"))).toBe(
      true,
    );
    expect(isDatabaseConnectionError(prismaError("PrismaClientKnownRequestError", "P2024"))).toBe(
      true,
    );
    expect(isDatabaseConnectionError(new Error("Can't reach database server at `db:5432`"))).toBe(
      true,
    );
    expect(isDatabaseConnectionError(prismaError("PrismaClientKnownRequestError", "P2002"))).toBe(
      false,
    );
    expect(isDatabaseConnectionError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isDatabaseConnectionError("P1001")).toBe(false);
  });

  it("counts only connection failures toward the alert", () => {
    const record = vi.spyOn(alerts.databaseConnection, "record");
    noteDatabaseError(prismaError("PrismaClientKnownRequestError", "P2002"), "request");
    noteDatabaseError(prismaError("PrismaClientKnownRequestError", "P1001"), "request");
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ where: "request" });
  });
});

describe("socket connections refused", () => {
  it("counts missing, forged and malformed tokens, but not expired ones", async () => {
    const record = vi.spyOn(alerts.socketAuthFailures, "record");
    const expired = jwt.sign({ userId: "u1", role: "RIDER", typ: "access" }, config.jwtSecret, {
      algorithm: "HS256",
      expiresIn: -10,
    });
    expect(await authenticateSocket(prisma, expired)).toBeNull();
    expect(record).not.toHaveBeenCalled();

    expect(await authenticateSocket(prisma, undefined)).toBeNull();
    expect(await authenticateSocket(prisma, "not-a-token")).toBeNull();
    const forged = jwt.sign({ userId: "u1", role: "ADMIN", typ: "access" }, "someone-elses-secret");
    expect(await authenticateSocket(prisma, forged)).toBeNull();
    expect(record.mock.calls.map(([detail]) => detail)).toEqual([
      { reason: "missing" },
      { reason: "invalid" },
      { reason: "invalid" },
    ]);
  });
});

describe("push failures", () => {
  afterEach(() => {
    setPushTransportForTests(null);
    resetPushStateForTests();
  });

  const fakePrisma = {
    pushToken: {
      findMany: async () => [
        { id: "t1", token: "ExponentPushToken[a]" },
        { id: "t2", token: "ExponentPushToken[b]" },
      ],
      deleteMany: async () => ({ count: 1 }),
    },
  } as never;

  it("counts refused pushes, but not uninstalled apps", async () => {
    const record = vi.spyOn(alerts.pushFailures, "record");
    setPushTransportForTests({
      send: async () => [
        { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        { status: "error", message: "bad credentials", details: { error: "InvalidCredentials" } },
      ],
      receipts: async () => ({}),
    });
    await sendPush(fakePrisma, { userIds: ["u1"], kind: "DRIVER_ASSIGNED", rideId: "r1" });
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({ stage: "send", error: "InvalidCredentials" });
  });
});
