import { Prisma, type BroadcastKind, type PrismaClient } from "@prisma/client";
import {
  BROADCAST_AUDIENCE_LABELS,
  LAUNCH_PUSH_TEXT,
  checkBroadcastText,
  effectiveLaunchMode,
  type BroadcastAudience,
  type BroadcastText,
} from "@rida/shared";
import { logger } from "../../lib/logger";
import { alerts } from "../../lib/alerts";
import { maskPhone } from "../../lib/redact";
import { normalizePhone } from "../../lib/phone";
import { LAUNCH_PUSH_KEY, readLaunchSetting } from "../launch/launchSettings";
import { isPushEnabled, sendAnnouncement } from "./pushService";

/**
 * Notifications an admin writes on the admin site's Notifications page, and
 * the one-time launch push. Built on pushService (the same Expo transport,
 * dead-token cleanup and receipt checks as ride notifications).
 *
 * - Who gets one: every install, with notifications allowed, of the app the
 *   audience uses — open accounts only, never review demo accounts.
 * - Caps, counted from the send history in the database (so a restart
 *   doesn't reset them), for all admins together: BROADCAST_CAP for the
 *   three "all" audiences, DIRECT_CAP for one number and tests. The launch
 *   push counts toward neither.
 * - A send is recorded (Broadcast) and audit-logged before anything goes
 *   out, then delivered in the background in batches of BATCH_SIZE installs,
 *   so a big send never holds up a request or the event loop.
 * - Push tokens and full phone numbers are never logged or stored here.
 */

const HOUR = 60 * 60_000;

export const BROADCAST_CAP = { max: 5, windowMs: HOUR } as const;
export const DIRECT_CAP = { max: 10, windowMs: HOUR } as const;
const BROADCAST_KINDS: BroadcastKind[] = ["RIDERS", "DRIVERS", "EVERYONE"];
const DIRECT_KINDS: BroadcastKind[] = ["PHONE", "TEST"];

/** Installs per database read and Expo round (Expo itself takes 100 per request). */
export const BATCH_SIZE = 500;

/** A send still marked SENDING after this long was cut off (a restart mid-send). */
const INTERRUPTED_AFTER_MS = 30 * 60_000;

/** One transaction-scoped lock for the cap check, so two sends at once can't both squeeze under it. */
const CAP_LOCK_KEY = 72_017_001;

const SYSTEM_ACTOR = "system";

/** A refused send. `status` is the HTTP answer; the message is for the admin. */
export class BroadcastError extends Error {
  constructor(
    readonly status: 400 | 404 | 429 | 503,
    message: string,
    /** On a 429: seconds until the cap lets another one through. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "BroadcastError";
  }
}

const OPEN = { deletedAt: null, isReviewDemo: false } as const;
const RIDER_INSTALLS: Prisma.PushTokenWhereInput = { app: "rider", user: { role: "RIDER", ...OPEN } };
const DRIVER_INSTALLS: Prisma.PushTokenWhereInput = { app: "driver", user: { role: "DRIVER", ...OPEN } };

interface Recipient {
  userId: string;
  role: "RIDER" | "DRIVER";
  name: string;
  maskedPhone: string;
}

/** The installs a send reaches. */
function installsFor(kind: BroadcastKind, recipient: Recipient | null): Prisma.PushTokenWhereInput {
  switch (kind) {
    case "RIDERS":
    case "LAUNCH":
      return RIDER_INSTALLS;
    case "DRIVERS":
      return DRIVER_INSTALLS;
    case "EVERYONE":
      return { OR: [RIDER_INSTALLS, DRIVER_INSTALLS] };
    case "PHONE":
    case "TEST":
      // No account: a where that matches nothing.
      return recipient
        ? { userId: recipient.userId, app: recipient.role === "DRIVER" ? "driver" : "rider" }
        : { id: { in: [] } };
  }
}

const RECIPIENT_SELECT = { id: true, role: true, name: true, phone: true } as const;

function toRecipient(user: { id: string; role: string; name: string; phone: string }): Recipient {
  return {
    userId: user.id,
    role: user.role === "DRIVER" ? "DRIVER" : "RIDER",
    name: user.name,
    maskedPhone: maskPhone(user.phone),
  };
}

/** The one open rider or driver account on a number typed by an admin. */
async function phoneRecipient(prisma: PrismaClient, raw: string | undefined): Promise<Recipient> {
  const phone = raw ? normalizePhone(raw) : null;
  if (!phone) throw new BroadcastError(400, "Enter a Ghanaian phone number.");
  const user = await prisma.user.findFirst({ where: { phone, deletedAt: null }, select: RECIPIENT_SELECT });
  if (!user) throw new BroadcastError(404, "No CampusRide account has that number.");
  if (user.role === "ADMIN") {
    throw new BroadcastError(
      400,
      "That's an admin account. Admin accounts can't sign in to the rider or driver app, so there is no phone to notify.",
    );
  }
  return toRecipient(user);
}

/**
 * "Send test to me": a rider or driver account on the admin's own number.
 * There is one account per number, so while that number is the admin
 * account there is none, and `adminMaskedPhone` lets the answer say why.
 */
async function testRecipient(
  prisma: PrismaClient,
  adminId: string,
): Promise<{ recipient: Recipient | null; adminMaskedPhone: string }> {
  const admin = await prisma.user.findUniqueOrThrow({ where: { id: adminId }, select: { phone: true } });
  const user = await prisma.user.findFirst({
    where: { phone: admin.phone, role: { in: ["RIDER", "DRIVER"] }, ...OPEN },
    select: RECIPIENT_SELECT,
  });
  return { recipient: user ? toRecipient(user) : null, adminMaskedPhone: maskPhone(admin.phone) };
}

function countInstalls(prisma: PrismaClient, kind: BroadcastKind, recipient: Recipient | null): Promise<number> {
  return prisma.pushToken.count({ where: installsFor(kind, recipient) });
}

export interface AudiencePreview {
  devices: number;
  recipient: { name: string; role: "RIDER" | "DRIVER"; maskedPhone: string } | null;
}

/** For the confirm box: how many installs a send would reach right now. */
export async function previewAudience(
  prisma: PrismaClient,
  audience: BroadcastAudience,
  phone?: string,
): Promise<AudiencePreview> {
  const recipient = audience === "PHONE" ? await phoneRecipient(prisma, phone) : null;
  const devices = await countInstalls(prisma, audience, recipient);
  return {
    devices,
    recipient: recipient
      ? { name: recipient.name, role: recipient.role, maskedPhone: recipient.maskedPhone }
      : null,
  };
}

function textOrThrow(input: { title?: unknown; body?: unknown }): BroadcastText {
  const checked = checkBroadcastText(input);
  if (!checked.ok) throw new BroadcastError(400, checked.error);
  return checked.text;
}

function pushOrThrow(): void {
  if (!isPushEnabled()) {
    throw new BroadcastError(503, "Push notifications are switched off on this server (PUSH_DISABLED).");
  }
}

/** "All riders, 120 device(s): "Title" / "Body"" — the audit log's record of a send. */
function auditReason(kind: BroadcastKind, recipient: Recipient | null, devices: number, text: BroadcastText): string {
  const who = recipient ? `${BROADCAST_AUDIENCE_LABELS[kind]} ${recipient.maskedPhone}` : BROADCAST_AUDIENCE_LABELS[kind];
  return `${who}, ${devices} device(s): "${text.title}" / "${text.body}"`;
}

/**
 * Records a send and its audit row together, after checking the cap under a
 * lock. Throws BroadcastError(429) when the cap is reached.
 */
async function recordSend(
  prisma: PrismaClient,
  actor: string,
  kind: BroadcastKind,
  recipient: Recipient | null,
  text: BroadcastText,
  devices: number,
  now: Date,
): Promise<string> {
  const direct = DIRECT_KINDS.includes(kind);
  const cap = direct ? DIRECT_CAP : BROADCAST_CAP;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAP_LOCK_KEY})`;
    const recent = await tx.broadcast.findMany({
      where: {
        kind: { in: direct ? DIRECT_KINDS : BROADCAST_KINDS },
        createdAt: { gt: new Date(now.getTime() - cap.windowMs) },
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    if (recent.length >= cap.max) {
      const freesAt = recent[recent.length - cap.max]!.createdAt.getTime() + cap.windowMs;
      throw new BroadcastError(
        429,
        direct
          ? `At most ${cap.max} single-number and test notifications an hour.`
          : `At most ${cap.max} notifications to all riders, all drivers or everyone an hour.`,
        Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)),
      );
    }
    const row = await tx.broadcast.create({
      data: {
        actor,
        kind,
        recipientId: recipient?.userId ?? null,
        maskedPhone: recipient?.maskedPhone ?? null,
        title: text.title,
        body: text.body,
        devices,
        createdAt: now,
      },
      select: { id: true },
    });
    await tx.adminAuditLog.create({
      data: {
        actor,
        action: kind === "TEST" ? "notification.test" : "notification.send",
        target: row.id,
        reason: auditReason(kind, recipient, devices, text),
      },
    });
    return row.id;
  });
}

/** Sends still going (tests wait for them; a shutdown doesn't need to). */
const inFlight = new Set<Promise<void>>();

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Sends a recorded broadcast, BATCH_SIZE installs at a time, updating its
 * counts after each batch (the history shows progress). Never throws.
 */
async function deliver(
  prisma: PrismaClient,
  broadcastId: string,
  where: Prisma.PushTokenWhereInput,
  text: BroadcastText,
): Promise<{ devices: number; delivered: number; failed: number }> {
  const totals = { devices: 0, delivered: 0, failed: 0, removed: 0 };
  try {
    let after = "";
    for (;;) {
      const page = await prisma.pushToken.findMany({
        // By id, past the last batch: rows deleted along the way (dead tokens) can't shift it.
        where: { AND: [where, { id: { gt: after } }] },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        select: { id: true, token: true, app: true },
      });
      if (page.length === 0) break;
      const result = await sendAnnouncement(prisma, page, text, broadcastId);
      totals.devices += page.length;
      totals.delivered += result.delivered;
      totals.failed += result.failed;
      totals.removed += result.removed;
      await prisma.broadcast.update({
        where: { id: broadcastId },
        data: { delivered: { increment: result.delivered }, failed: { increment: result.failed } },
      });
      if (page.length < BATCH_SIZE) break;
      after = page[page.length - 1]!.id;
      // Let requests waiting on the server in between.
      await nextTick();
    }
    await prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: "SENT", devices: totals.devices, finishedAt: new Date() },
    });
    logger.info("broadcast sent", { broadcastId, ...totals });
  } catch (err) {
    logger.error("broadcast: send failed", { err, broadcastId, ...totals });
    alerts.pushFailures.record({ stage: "send", error: err instanceof Error ? err.message : String(err) });
    await prisma.broadcast
      .update({ where: { id: broadcastId }, data: { status: "FAILED", finishedAt: new Date() } })
      .catch((e) => logger.error("broadcast: could not record failure", { err: e, broadcastId }));
  }
  return totals;
}

function deliverInBackground(
  prisma: PrismaClient,
  broadcastId: string,
  where: Prisma.PushTokenWhereInput,
  text: BroadcastText,
): void {
  const running = deliver(prisma, broadcastId, where, text).then(() => undefined);
  inFlight.add(running);
  void running.finally(() => inFlight.delete(running));
}

export interface StartBroadcastInput {
  audience: BroadcastAudience;
  phone?: string;
  title?: unknown;
  body?: unknown;
}

/**
 * Sends an admin's notification: checks it, records it (history + audit
 * log, within the cap), and starts delivering it in the background. Returns
 * at once with the history row.
 */
export async function startBroadcast(
  prisma: PrismaClient,
  actor: string,
  input: StartBroadcastInput,
  now = new Date(),
): Promise<BroadcastView> {
  const text = textOrThrow(input);
  pushOrThrow();
  const recipient = input.audience === "PHONE" ? await phoneRecipient(prisma, input.phone) : null;
  const where = installsFor(input.audience, recipient);
  const devices = await prisma.pushToken.count({ where });
  const id = await recordSend(prisma, actor, input.audience, recipient, text, devices, now);
  if (devices === 0) {
    await prisma.broadcast.update({ where: { id }, data: { status: "SENT", finishedAt: new Date() } });
  } else {
    deliverInBackground(prisma, id, where, text);
  }
  return (await viewsOf(prisma, [await prisma.broadcast.findUniqueOrThrow({ where: { id } })]))[0]!;
}

export interface TestSendResult {
  devices: number;
  delivered: number;
  failed: number;
  /** What the admin is told: where it went, or why nothing arrived. */
  message: string;
}

/**
 * "Send test to me": only to a rider or driver account on the admin's own
 * number, and only its installs. Waits for the send (a handful of installs)
 * and says plainly why nothing arrived when nothing could.
 */
export async function sendTestToSelf(
  prisma: PrismaClient,
  actor: string,
  input: { title?: unknown; body?: unknown },
  now = new Date(),
): Promise<TestSendResult> {
  const text = textOrThrow(input);
  pushOrThrow();
  const { recipient, adminMaskedPhone } = await testRecipient(prisma, actor);
  const where = installsFor("TEST", recipient);
  const devices = await prisma.pushToken.count({ where });
  const id = await recordSend(prisma, actor, "TEST", recipient, text, devices, now);

  if (!recipient) {
    await prisma.broadcast.update({ where: { id }, data: { status: "SENT", finishedAt: new Date() } });
    return {
      devices: 0,
      delivered: 0,
      failed: 0,
      message: `Nothing was sent. Your number (${adminMaskedPhone}) is your admin account, and CampusRide allows one account per phone number, so no rider or driver app can be signed in with it. To see a notification on a phone, choose "One phone number" and use a rider or driver account you can check.`,
    };
  }
  const app = recipient.role === "DRIVER" ? "driver" : "rider";
  if (devices === 0) {
    await prisma.broadcast.update({ where: { id }, data: { status: "SENT", finishedAt: new Date() } });
    return {
      devices: 0,
      delivered: 0,
      failed: 0,
      message: `Nothing was sent. Your ${app} account (${recipient.maskedPhone}) has no phone with notifications allowed. Sign in to the ${app} app, allow notifications, then try again.`,
    };
  }
  const sent = await deliver(prisma, id, where, text);
  return {
    ...sent,
    message:
      sent.failed === 0
        ? `Sent to ${sent.delivered} device(s) signed in to your ${app} account.`
        : `${sent.delivered} of ${sent.devices} device(s) accepted it; ${sent.failed} failed (an uninstalled app is removed from the list).`,
  };
}

// ─── The launch push ────────────────────────────────────────────────────────

/** Set once the launch push exists, so later checks cost nothing. */
let launchPushDone = false;

/**
 * Sends "CampusRide is live!" to every rider install with notifications
 * allowed — once ever — when the Settings switch is on and launch mode in
 * force is LIVE (set by hand, or a countdown that reached its time). Called
 * after every launch mode change and on a timer (index.ts), so a countdown
 * that ends by itself is announced within a tick, and after a restart too.
 *
 * Exactly once: the Broadcast row with key "launch" is inserted before
 * anything is sent, and its key is unique — a second attempt (another
 * server, a restart, Live switched off and on) fails to insert and sends
 * nothing. A send cut off by a crash is not retried: never twice beats
 * always complete. Never throws.
 */
export async function maybeSendLaunchPush(prisma: PrismaClient, now = new Date()): Promise<boolean> {
  try {
    if (launchPushDone || !isPushEnabled()) return false;
    const setting = await readLaunchSetting(prisma);
    if (!setting.launchPushEnabled || effectiveLaunchMode(setting, now) !== "LIVE") return false;

    const where = installsFor("LAUNCH", null);
    const devices = await prisma.pushToken.count({ where });
    let id: string;
    try {
      id = await prisma.$transaction(async (tx) => {
        const row = await tx.broadcast.create({
          data: {
            key: LAUNCH_PUSH_KEY,
            actor: SYSTEM_ACTOR,
            kind: "LAUNCH",
            title: LAUNCH_PUSH_TEXT.title,
            body: LAUNCH_PUSH_TEXT.body,
            devices,
          },
          select: { id: true },
        });
        await tx.adminAuditLog.create({
          data: {
            actor: SYSTEM_ACTOR,
            action: "notification.launch",
            target: row.id,
            reason: auditReason("LAUNCH", null, devices, LAUNCH_PUSH_TEXT),
          },
        });
        return row.id;
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        launchPushDone = true;
        return false;
      }
      throw err;
    }
    launchPushDone = true;
    logger.info("launch push: sending", { broadcastId: id, devices });
    deliverInBackground(prisma, id, where, LAUNCH_PUSH_TEXT);
    return true;
  } catch (err) {
    logger.error("launch push: check failed", { err });
    return false;
  }
}

// ─── History ────────────────────────────────────────────────────────────────

export interface BroadcastView {
  id: string;
  kind: BroadcastKind;
  audienceLabel: string;
  maskedPhone: string | null;
  title: string;
  body: string;
  /** INTERRUPTED: still SENDING long after it started (the server restarted mid-send). */
  status: "SENDING" | "SENT" | "FAILED" | "INTERRUPTED";
  devices: number;
  delivered: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
  /** The admin who sent it; null for the launch push (sent by the server). */
  sentBy: { id: string; name: string } | null;
}

type BroadcastRow = Prisma.BroadcastGetPayload<object>;

async function viewsOf(prisma: PrismaClient, rows: BroadcastRow[], now = Date.now()): Promise<BroadcastView[]> {
  const actorIds = [...new Set(rows.map((r) => r.actor).filter((a) => a !== SYSTEM_ACTOR))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const byId = new Map(actors.map((a) => [a.id, a]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    audienceLabel: BROADCAST_AUDIENCE_LABELS[r.kind],
    maskedPhone: r.maskedPhone,
    title: r.title,
    body: r.body,
    status:
      r.status === "SENDING" && now - r.createdAt.getTime() > INTERRUPTED_AFTER_MS ? "INTERRUPTED" : r.status,
    devices: r.devices,
    delivered: r.delivered,
    failed: r.failed,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    sentBy: r.actor === SYSTEM_ACTOR ? null : (byId.get(r.actor) ?? { id: r.actor, name: "Former admin" }),
  }));
}

export interface CapStatus {
  used: number;
  max: number;
}

/** The newest sends, and how much of each cap the last hour used. */
export async function broadcastHistory(
  prisma: PrismaClient,
  take = 50,
  now = new Date(),
): Promise<{ broadcasts: BroadcastView[]; caps: { broadcast: CapStatus; direct: CapStatus } }> {
  const since = new Date(now.getTime() - HOUR);
  const [rows, broadcastUsed, directUsed] = await Promise.all([
    prisma.broadcast.findMany({ orderBy: { createdAt: "desc" }, take }),
    prisma.broadcast.count({ where: { kind: { in: BROADCAST_KINDS }, createdAt: { gt: since } } }),
    prisma.broadcast.count({ where: { kind: { in: DIRECT_KINDS }, createdAt: { gt: since } } }),
  ]);
  return {
    broadcasts: await viewsOf(prisma, rows, now.getTime()),
    caps: {
      broadcast: { used: broadcastUsed, max: BROADCAST_CAP.max },
      direct: { used: directUsed, max: DIRECT_CAP.max },
    },
  };
}

/** The launch push as Settings shows it, or null before it has gone out. */
export async function launchPushSent(prisma: PrismaClient): Promise<BroadcastView | null> {
  const row = await prisma.broadcast.findUnique({ where: { key: LAUNCH_PUSH_KEY } });
  return row ? (await viewsOf(prisma, [row]))[0]! : null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

/** Tests only: wait for every background send to finish. */
export async function settleBroadcastsForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/** Tests only: forget that the launch push was seen. */
export function resetLaunchPushForTests(): void {
  launchPushDone = false;
}
