import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db/prisma";
import { createTestUser } from "../ride/testFixtures";
import { logout } from "../auth/authService";
import { deleteAccount } from "../auth/deleteAccount";
import { generateRefreshTokenValue, sha256 } from "../auth/hash";
import {
  InvalidPushTokenError,
  MAX_TOKENS_PER_USER,
  PUSH_TOKEN_TOUCH_AFTER_MS,
  checkPushReceipts,
  registerPushToken,
  resetPushStateForTests,
  sendPush,
  setPushTransportForTests,
} from "./pushService";
import { fakeTransport, newToken } from "./testFixtures";

const userIds: string[] = [];
async function user(role: "RIDER" | "DRIVER", name?: string) {
  const u = await createTestUser(role);
  userIds.push(u.id);
  if (name) await prisma.user.update({ where: { id: u.id }, data: { name } });
  return u;
}

let fake: ReturnType<typeof fakeTransport>;

beforeEach(() => {
  resetPushStateForTests();
  fake = fakeTransport();
  setPushTransportForTests(fake.transport);
});

afterEach(async () => {
  await prisma.pushToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});

afterAll(() => {
  setPushTransportForTests(null);
});

describe("registerPushToken", () => {
  it("saves a token, and moves it to whoever signs in on that phone next", async () => {
    const a = await user("RIDER");
    const b = await user("RIDER");
    const token = newToken();
    await registerPushToken(
      prisma,
      { userId: a.id, role: "RIDER" },
      { token, app: "rider", platform: "android" },
    );
    await registerPushToken(
      prisma,
      { userId: b.id, role: "RIDER" },
      { token, app: "rider", platform: "android" },
    );
    const rows = await prisma.pushToken.findMany({ where: { token } });
    expect(rows.map((r) => r.userId)).toEqual([b.id]);
  });

  it("refuses bad input and the wrong app for the account", async () => {
    const rider = await user("RIDER");
    const me = { userId: rider.id, role: "RIDER" };
    const bad = [
      { token: "not-a-token", app: "rider", platform: "android" },
      { token: newToken(), app: "admin", platform: "android" },
      { token: newToken(), app: "rider", platform: "windows" },
      { token: newToken(), app: "driver", platform: "android" },
    ];
    for (const input of bad) {
      await expect(
        registerPushToken(prisma, me, input),
        JSON.stringify(input),
      ).rejects.toBeInstanceOf(InvalidPushTokenError);
    }
    expect(await prisma.pushToken.count({ where: { userId: rider.id } })).toBe(0);
  });

  it("the same token sent again writes nothing; a day later it is touched once", async () => {
    const rider = await user("RIDER");
    const me = { userId: rider.id, role: "RIDER" };
    const input = { token: newToken(), app: "rider", platform: "ios" };
    await registerPushToken(prisma, me, input);
    const saved = await prisma.pushToken.findUniqueOrThrow({ where: { token: input.token } });

    const upsert = vi.spyOn(prisma.pushToken, "upsert");
    try {
      for (let i = 0; i < 20; i++) await registerPushToken(prisma, me, input);
      expect(upsert).not.toHaveBeenCalled();
      expect(
        (await prisma.pushToken.findUniqueOrThrow({ where: { token: input.token } })).updatedAt,
      ).toEqual(saved.updatedAt);

      const tomorrow = new Date(Date.now() + PUSH_TOKEN_TOUCH_AFTER_MS + 60_000);
      await registerPushToken(prisma, me, input, tomorrow);
      expect(upsert).toHaveBeenCalledTimes(1);
    } finally {
      upsert.mockRestore();
    }
  });

  it("the same token for another person or platform is written", async () => {
    const a = await user("RIDER");
    const b = await user("RIDER");
    const token = newToken();
    await registerPushToken(prisma, { userId: a.id, role: "RIDER" }, { token, app: "rider", platform: "ios" });
    await registerPushToken(prisma, { userId: a.id, role: "RIDER" }, { token, app: "rider", platform: "android" });
    expect((await prisma.pushToken.findUniqueOrThrow({ where: { token } })).platform).toBe("android");
    await registerPushToken(prisma, { userId: b.id, role: "RIDER" }, { token, app: "rider", platform: "android" });
    expect((await prisma.pushToken.findUniqueOrThrow({ where: { token } })).userId).toBe(b.id);
  });

  it(`keeps only the newest ${MAX_TOKENS_PER_USER} installs per person`, async () => {
    const rider = await user("RIDER");
    const tokens = Array.from({ length: MAX_TOKENS_PER_USER + 2 }, newToken);
    for (const token of tokens) {
      await registerPushToken(
        prisma,
        { userId: rider.id, role: "RIDER" },
        { token, app: "rider", platform: "ios" },
      );
    }
    const kept = await prisma.pushToken.findMany({ where: { userId: rider.id } });
    expect(kept).toHaveLength(MAX_TOKENS_PER_USER);
    expect(kept.map((k) => k.token)).toContain(tokens[tokens.length - 1]);
    expect(kept.map((k) => k.token)).not.toContain(tokens[0]);
  });
});

describe("removing tokens", () => {
  it("log out deletes that install's token only", async () => {
    const rider = await user("RIDER");
    const [mine, other] = [newToken(), newToken()];
    for (const token of [mine, other]) {
      await registerPushToken(
        prisma,
        { userId: rider.id, role: "RIDER" },
        { token, app: "rider", platform: "android" },
      );
    }
    const refresh = generateRefreshTokenValue();
    await prisma.refreshToken.create({
      data: {
        userId: rider.id,
        tokenHash: sha256(refresh),
        expiresAt: new Date(Date.now() + 60_000),
        familyId: randomUUID(),
      },
    });
    await logout(prisma, refresh, new Date(), mine);
    const left = await prisma.pushToken.findMany({ where: { userId: rider.id } });
    expect(left.map((t) => t.token)).toEqual([other]);
  });

  it("deleting the account deletes every token", async () => {
    const rider = await user("RIDER");
    await registerPushToken(
      prisma,
      { userId: rider.id, role: "RIDER" },
      { token: newToken(), app: "rider", platform: "android" },
    );
    await deleteAccount(prisma, rider.id);
    expect(await prisma.pushToken.count({ where: { userId: rider.id } })).toBe(0);
  });
});

describe("sendPush", () => {
  async function riderWithToken(name = "Ama Serwaa") {
    const rider = await user("RIDER", name);
    const token = newToken();
    await registerPushToken(
      prisma,
      { userId: rider.id, role: "RIDER" },
      { token, app: "rider", platform: "android" },
    );
    return { rider, token };
  }

  it("sends to the person's rider-app installs on the Ride updates channel, first name only", async () => {
    const { rider, token } = await riderWithToken();
    await sendPush(prisma, {
      userIds: [rider.id],
      kind: "DRIVER_ARRIVED",
      rideId: "ride1",
      text: { driverName: "Kofi Mensah" },
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      to: token,
      title: "Your driver is here",
      body: "Kofi is at your pickup.",
      channelId: "ride-updates",
      data: { kind: "DRIVER_ARRIVED", rideId: "ride1" },
      priority: "high",
      sound: "default",
    });
  });

  it("uses the driver app's tokens and Ride requests channel for driver kinds", async () => {
    const driver = await user("DRIVER");
    const token = newToken();
    await registerPushToken(
      prisma,
      { userId: driver.id, role: "DRIVER" },
      { token, app: "driver", platform: "android" },
    );
    await sendPush(prisma, {
      userIds: [driver.id],
      kind: "RIDE_REQUEST",
      rideId: "ride2",
      text: { pickupName: "Balme Library" },
    });
    expect(fake.sent[0]).toMatchObject({ to: token, channelId: "ride-requests", ttl: 90 });
    // A rider kind never goes to a driver-app install.
    await sendPush(prisma, { userIds: [driver.id], kind: "TRIP_STARTED", rideId: "ride2" });
    expect(fake.sent).toHaveLength(1);
  });

  it("does not send the same notification twice in a row", async () => {
    const { rider } = await riderWithToken();
    const send = () =>
      sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride3" });
    await send();
    await send();
    expect(fake.sent).toHaveLength(1);
  });

  it("caps how many one person gets in a minute", async () => {
    const { rider } = await riderWithToken();
    for (let i = 0; i < 10; i++) {
      await sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: `burst-${i}` });
    }
    expect(fake.sent.length).toBeLessThan(10);
    expect(fake.sent.length).toBeGreaterThan(0);
  });

  it("deletes a token at once when Expo says the device is gone", async () => {
    const { rider, token } = await riderWithToken();
    fake.setTickets(() => ({
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    }));
    await sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride4" });
    expect(await prisma.pushToken.count({ where: { token } })).toBe(0);
  });

  it("deletes a token when a later receipt says the device is gone", async () => {
    const { rider, token } = await riderWithToken();
    fake.setTickets(() => ({ status: "ok", id: "receipt-dead" }));
    await sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride5" });
    fake.receiptsById["receipt-dead"] = {
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    };

    // Too early: receipts are only checked ~15 minutes after the send.
    await checkPushReceipts(prisma, Date.now());
    expect(await prisma.pushToken.count({ where: { token } })).toBe(1);

    await checkPushReceipts(prisma, Date.now() + 16 * 60_000);
    expect(await prisma.pushToken.count({ where: { token } })).toBe(0);
  });

  it("keeps the token when delivery succeeded or failed for another reason", async () => {
    const { rider, token } = await riderWithToken();
    fake.setTickets(() => ({ status: "ok", id: "receipt-other" }));
    await sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride6" });
    fake.receiptsById["receipt-other"] = {
      status: "error",
      message: "busy",
      details: { error: "MessageRateExceeded" },
    };
    await checkPushReceipts(prisma, Date.now() + 16 * 60_000);
    expect(await prisma.pushToken.count({ where: { token } })).toBe(1);
  });

  it("never throws, even when Expo is unreachable", async () => {
    const { rider, token } = await riderWithToken();
    fake.failSends();
    await expect(
      sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride7" }),
    ).resolves.toBeUndefined();
    expect(await prisma.pushToken.count({ where: { token } })).toBe(1);
  });

  it("does nothing when push is switched off", async () => {
    const { rider } = await riderWithToken();
    setPushTransportForTests(null);
    await sendPush(prisma, { userIds: [rider.id], kind: "TRIP_STARTED", rideId: "ride8" });
    expect(fake.sent).toHaveLength(0);
  });
});
