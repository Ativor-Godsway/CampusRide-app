import type { PrismaClient } from "@prisma/client";
import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";
import {
  ANDROID_CHANNELS,
  appForKind,
  pushText,
  type PushApp,
  type PushData,
  type PushKind,
  type PushTextInput,
} from "@rida/shared";
import { config } from "../../config";
import { logger } from "../../lib/logger";
import { alerts } from "../../lib/alerts";
import { PushRateLimiter } from "./rateLimit";

/**
 * Push notifications through the Expo push service (expo-server-sdk).
 *
 * Every entry point here is fire-and-forget: it never throws and is never
 * awaited by a ride transition, so a failed or slow push can't break or delay
 * the ride flow. Failures are logged. Push tokens are never logged (they
 * address a phone); token row ids are.
 *
 * Tokens Expo says are dead (DeviceNotRegistered — the app was uninstalled
 * or its permission revoked) are deleted, both when the send is answered
 * ("tickets") and when the delivery result comes in later ("receipts",
 * checked by checkPushReceipts on a timer).
 */

/** The two calls we make to Expo, swappable so tests never reach the network. */
export interface PushTransport {
  /** Sends the messages (chunked as Expo requires); one ticket per message, in order. */
  send(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  receipts(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

function expoTransport(accessToken: string | undefined): PushTransport {
  const expo = new Expo(accessToken ? { accessToken } : {});
  return {
    async send(messages) {
      const tickets: ExpoPushTicket[] = [];
      for (const chunk of expo.chunkPushNotifications(messages)) {
        try {
          tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
        } catch (err) {
          // The whole chunk failed (network, Expo outage): report each
          // message as failed so the indexes still line up.
          logger.warn("push: send request failed", { err, messages: chunk.length });
          for (let i = 0; i < chunk.length; i++) {
            tickets.push({ status: "error", message: "send request failed" });
          }
        }
      }
      return tickets;
    },
    async receipts(ids) {
      const out: Record<string, ExpoPushReceipt> = {};
      for (const chunk of expo.chunkPushNotificationReceiptIds(ids)) {
        try {
          Object.assign(out, await expo.getPushNotificationReceiptsAsync(chunk));
        } catch (err) {
          logger.warn("push: receipt request failed", { err, ids: chunk.length });
        }
      }
      return out;
    },
  };
}

let transport: PushTransport | null = config.push.enabled
  ? expoTransport(config.push.accessToken)
  : null;

/** False when push is switched off (PUSH_DISABLED, or under tests): callers skip their lookups too. */
export function isPushEnabled(): boolean {
  return transport !== null;
}

/** Tests only: route sends to a fake (or null to switch push off again). */
export function setPushTransportForTests(next: PushTransport | null): void {
  transport = next;
}

const limiter = new PushRateLimiter();

/** How long a repeat of the same notification is dropped, per kind. */
const DEDUPE_MS: Record<PushKind, number> = {
  DRIVER_ASSIGNED: 60_000,
  // Once per pickup: the driver's location keeps streaming while they're close.
  DRIVER_ARRIVING: 2 * 60 * 60_000,
  DRIVER_ARRIVED: 60_000,
  TRIP_STARTED: 60_000,
  TRIP_COMPLETED: 60_000,
  DRIVER_CANCELLED: 60_000,
  NO_DRIVER_FOUND: 5 * 60_000,
  // A request re-broadcast (rider keeps waiting, switches type) doesn't ping
  // the same driver again within its window.
  RIDE_REQUEST: 10 * 60_000,
  RIDER_CANCELLED: 60_000,
};

/**
 * How long Expo/FCM/APNs keep trying to deliver, in seconds. A ride request
 * is worthless after its offer window; trip news is stale after minutes.
 */
const TTL_SECONDS: Record<PushApp, Partial<Record<PushKind, number>>> = {
  rider: {},
  driver: { RIDE_REQUEST: 90 },
};
const DEFAULT_TTL_SECONDS = 10 * 60;

/** Receipts are ready after a delay; Expo suggests waiting about 15 minutes. */
const RECEIPT_DELAY_MS = 15 * 60_000;
/** Expo keeps receipts for 24 hours; after that, stop asking. */
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000;
/** Ceiling on receipts waiting to be checked, so memory stays bounded. */
const MAX_PENDING_RECEIPTS = 50_000;

/** Receipt id -> the token row it was sent to, waiting to be checked. */
const pendingReceipts = new Map<string, { tokenId: string; sentAt: number }>();

export interface SendPushInput {
  userIds: readonly string[];
  kind: PushKind;
  rideId: string;
  text?: PushTextInput;
}

/**
 * Sends one notification to each of these people's phones (the app the kind
 * belongs to only). Never throws; resolves once Expo has answered.
 */
export async function sendPush(prisma: PrismaClient, input: SendPushInput): Promise<void> {
  try {
    if (!transport || input.userIds.length === 0) return;
    const now = Date.now();
    const allowed = [...new Set(input.userIds)].filter((userId) =>
      limiter.allow(userId, `${input.kind}:${input.rideId}`, DEDUPE_MS[input.kind], now),
    );
    if (allowed.length === 0) return;

    const app = appForKind(input.kind);
    const tokens = await prisma.pushToken.findMany({
      where: { userId: { in: allowed }, app },
      select: { id: true, token: true },
    });
    if (tokens.length === 0) return;

    const { title, body } = pushText(input.kind, input.text);
    const data: PushData = { kind: input.kind, rideId: input.rideId };
    const messages: ExpoPushMessage[] = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      data: { ...data },
      sound: "default",
      priority: "high",
      channelId: ANDROID_CHANNELS[app].id,
      ttl: TTL_SECONDS[app][input.kind] ?? DEFAULT_TTL_SECONDS,
    }));

    const tickets = await transport.send(messages);
    await handleTickets(prisma, tokens, tickets, now);
    logger.info("push sent", { kind: input.kind, rideId: input.rideId, devices: tokens.length });
  } catch (err) {
    logger.error("push: send failed", { err, kind: input.kind, rideId: input.rideId });
    alerts.pushFailures.record({
      stage: "send",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleTickets(
  prisma: PrismaClient,
  tokens: ReadonlyArray<{ id: string }>,
  tickets: readonly ExpoPushTicket[],
  now: number,
): Promise<void> {
  const dead: string[] = [];
  tickets.forEach((ticket, i) => {
    const tokenId = tokens[i]?.id;
    if (!tokenId) return;
    if (ticket.status === "ok") {
      if (pendingReceipts.size < MAX_PENDING_RECEIPTS)
        pendingReceipts.set(ticket.id, { tokenId, sentAt: now });
      return;
    }
    if (ticket.details?.error === "DeviceNotRegistered") dead.push(tokenId);
    else {
      logger.warn("push: not accepted", {
        tokenId,
        error: ticket.details?.error ?? ticket.message,
      });
      alerts.pushFailures.record({ stage: "send", error: ticket.details?.error ?? ticket.message });
    }
  });
  await deleteTokens(prisma, dead, "ticket");
}

async function deleteTokens(
  prisma: PrismaClient,
  tokenIds: string[],
  source: string,
): Promise<void> {
  if (tokenIds.length === 0) return;
  const { count } = await prisma.pushToken.deleteMany({ where: { id: { in: tokenIds } } });
  logger.info("push: removed tokens Expo reports as unregistered", { count, source });
}

/**
 * Checks delivery receipts for sends at least RECEIPT_DELAY_MS old and
 * deletes the tokens Expo reports as DeviceNotRegistered. Run on a timer
 * (index.ts). Never throws.
 */
export async function checkPushReceipts(
  prisma: PrismaClient,
  now: number = Date.now(),
): Promise<void> {
  try {
    limiter.sweep(now);
    if (!transport) return;
    const due = [...pendingReceipts.entries()].filter(
      ([, p]) => now - p.sentAt >= RECEIPT_DELAY_MS,
    );
    if (due.length === 0) return;

    const receipts = await transport.receipts(due.map(([id]) => id));
    const dead: string[] = [];
    for (const [id, pending] of due) {
      const receipt = receipts[id];
      if (!receipt) {
        // Not ready yet (or Expo didn't answer): try again later, within reason.
        if (now - pending.sentAt >= RECEIPT_GIVE_UP_MS) pendingReceipts.delete(id);
        continue;
      }
      pendingReceipts.delete(id);
      if (receipt.status === "ok") continue;
      if (receipt.details?.error === "DeviceNotRegistered") dead.push(pending.tokenId);
      else {
        logger.warn("push: not delivered", {
          tokenId: pending.tokenId,
          error: receipt.details?.error ?? receipt.message,
        });
        alerts.pushFailures.record({
          stage: "delivery",
          error: receipt.details?.error ?? receipt.message,
        });
      }
    }
    await deleteTokens(prisma, dead, "receipt");
  } catch (err) {
    logger.error("push: receipt check failed", { err });
  }
}

/** Tests only: forget pending receipts and rate-limit state between tests. */
export function resetPushStateForTests(): void {
  pendingReceipts.clear();
  limiter.sweep(Number.MAX_SAFE_INTEGER);
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

/** Most installs one person keeps registered; older ones are dropped. */
export const MAX_TOKENS_PER_USER = 5;

const ROLE_FOR_APP: Record<PushApp, string> = { rider: "RIDER", driver: "DRIVER" };

export class InvalidPushTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPushTokenError";
  }
}

export interface RegisterPushTokenInput {
  token?: unknown;
  app?: unknown;
  platform?: unknown;
}

/**
 * Saves (or moves to this user) the push token of the app install they're
 * signed in on. Validates everything; throws InvalidPushTokenError with a
 * plain message on bad input.
 */
export async function registerPushToken(
  prisma: PrismaClient,
  user: { userId: string; role: string },
  input: RegisterPushTokenInput,
): Promise<void> {
  const { token, app, platform } = input;
  if (typeof token !== "string" || token.length > 255 || !Expo.isExpoPushToken(token)) {
    throw new InvalidPushTokenError("token must be an Expo push token");
  }
  if (app !== "rider" && app !== "driver")
    throw new InvalidPushTokenError("app must be rider or driver");
  if (platform !== "android" && platform !== "ios")
    throw new InvalidPushTokenError("platform must be android or ios");
  if (ROLE_FOR_APP[app] !== user.role)
    throw new InvalidPushTokenError(`a ${user.role} account can't use the ${app} app`);

  await prisma.pushToken.upsert({
    where: { token },
    create: { userId: user.userId, token, app, platform },
    update: { userId: user.userId, app, platform },
  });

  // Keep only the newest few installs per person.
  const stale = await prisma.pushToken.findMany({
    where: { userId: user.userId },
    orderBy: { updatedAt: "desc" },
    skip: MAX_TOKENS_PER_USER,
    select: { id: true },
  });
  if (stale.length > 0)
    await prisma.pushToken.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
}

/** Forgets one install's token for this user (log out). Unknown tokens are fine. */
export async function removePushToken(
  prisma: PrismaClient,
  userId: string,
  token: string,
): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { userId, token } });
}
