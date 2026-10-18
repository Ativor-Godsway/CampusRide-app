/**
 * The admin site's "Delete account" tab, for people who ask by email. Pins:
 *   1. the whole flow: look up, text a code, check it, delete;
 *   2. only a right, unexpired code unlocks deleting, for that account only;
 *   3. it closes the account exactly as the in-app delete does;
 *   4. admin accounts and people on a ride are refused, as in the app;
 *   5. every step is in the audit log, with the number masked and never the code.
 */
import { describe, it, expect, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { registerAdminAccountDeletionRoutes, EMAIL_DELETION_CODE_TTL_MINUTES } from "./adminAccountDeletion";
import { signAccessToken, signDeletionConfirmToken } from "../services/auth/tokens";
import { CapturingOtpService } from "../services/auth/testFixtures";
import { sha256 } from "../services/auth/hash";
import { DELETED_NAME_PLACEHOLDER, deletedPhonePlaceholder } from "../services/auth/deleteAccount";
import { setRateLimitStore } from "../rateLimit/limiter";
import { MemoryRateLimitStore } from "../rateLimit/store";
import { RULES } from "../rateLimit/rules";
import { maskPhone } from "../lib/redact";
import { createTestUser, createTestDriver, createTestRide, cleanupRide } from "../services/ride/testFixtures";

let app: FastifyInstance;
const otp = new CapturingOtpService();
const userIds: string[] = [];
const rideIds: string[] = [];
const allowlist = config.adminPhoneAllowlist.phones;

beforeAll(async () => {
  app = Fastify();
  registerAdminAccountDeletionRoutes(app, prisma, otp);
  await app.ready();
});

beforeEach(() => {
  // One code per number per cooldown, across tests too.
  setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
});

afterEach(async () => {
  allowlist.splice(0, allowlist.length);
  while (rideIds.length > 0) await cleanupRide(rideIds.pop()!);
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ actor: { in: userIds } }, { target: { in: userIds } }] },
  });
  await prisma.otpCode.deleteMany({ where: { phone: { in: [...otp.sent.keys()] } } });
  await prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function admin() {
  const created = await createTestUser("RIDER");
  const user = await prisma.user.update({ where: { id: created.id }, data: { role: "ADMIN" } });
  userIds.push(user.id);
  return { user, auth: { authorization: `Bearer ${signAccessToken({ userId: user.id, role: "ADMIN" })}` } };
}

async function rider() {
  const user = await createTestUser("RIDER");
  userIds.push(user.id);
  return user;
}

/** "054..." as the email would give it, not the canonical +233 form. */
function local(phone: string) {
  return `0${phone.slice(4)}`;
}

function lookUp(auth: Record<string, string>, phone: string) {
  return app.inject({ method: "GET", url: `/admin/account-deletion?phone=${encodeURIComponent(phone)}`, headers: auth });
}
function sendCode(auth: Record<string, string>, phone: string) {
  return app.inject({ method: "POST", url: "/admin/account-deletion/code", headers: auth, payload: { phone } });
}
function verify(auth: Record<string, string>, phone: string, code: string) {
  return app.inject({ method: "POST", url: "/admin/account-deletion/verify", headers: auth, payload: { phone, code } });
}
function remove(auth: Record<string, string>, phone: string, confirmToken: string) {
  return app.inject({
    method: "POST",
    url: "/admin/account-deletion/delete",
    headers: auth,
    payload: { phone, confirmToken },
  });
}

/** Sends a code and checks it; returns the confirm token. */
async function confirmed(auth: Record<string, string>, phone: string) {
  expect((await sendCode(auth, phone)).statusCode).toBe(200);
  const res = await verify(auth, phone, otp.codeFor(phone));
  expect(res.statusCode).toBe(200);
  return res.json().confirmToken as string;
}

async function auditRows(actor: string) {
  return prisma.adminAuditLog.findMany({ where: { actor }, orderBy: { timestamp: "asc" } });
}

describe("looking up a number", () => {
  it("shows the account's name, role and when it was created, from any spelling of the number", async () => {
    const { auth } = await admin();
    const person = await rider();

    const res = await lookUp(auth, local(person.phone));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      phone: person.phone,
      account: { id: person.id, name: person.name, role: "RIDER", createdAt: person.createdAt.toISOString() },
      blocked: null,
    });
  });

  it("says when there's no account, and records the lookup either way", async () => {
    const { user, auth } = await admin();
    const nobody = "+233209999871";

    const res = await lookUp(auth, nobody);
    expect(res.json()).toMatchObject({ phone: nobody, account: null, blocked: null });
    const [row] = await auditRows(user.id);
    expect(row).toMatchObject({
      action: "account_deletion.lookup",
      target: maskPhone(nobody),
      reason: `${maskPhone(nobody)}: no account`,
    });
  });

  it("rejects a number that isn't Ghanaian", async () => {
    const { auth } = await admin();
    expect((await lookUp(auth, "12345")).statusCode).toBe(400);
  });
});

describe("the whole flow", () => {
  it("texts a code that says what it's for and lasts 30 minutes, then deletes with it", async () => {
    const { user: me, auth } = await admin();
    const person = await rider();

    const sent = await sendCode(auth, person.phone);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toEqual({ sent: true, phone: maskPhone(person.phone), expiresInMinutes: 30 });
    const code = otp.codeFor(person.phone);
    expect(otp.messages.get(person.phone)).toContain(code);
    expect(otp.messages.get(person.phone)).toMatch(/reply to our email/i);
    const row = await prisma.otpCode.findFirstOrThrow({
      where: { phone: person.phone, purpose: "ACCOUNT_DELETION" },
    });
    const ttl = row.expiresAt.getTime() - row.createdAt.getTime();
    expect(ttl).toBe(EMAIL_DELETION_CODE_TTL_MINUTES * 60_000);

    const checked = await verify(auth, person.phone, code);
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual({ verified: true, confirmToken: expect.any(String), expiresInMinutes: 5 });

    const deleted = await remove(auth, person.phone, checked.json().confirmToken);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ deleted: true, role: "RIDER", erasedAfter: expect.any(String) });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: person.id } });
    expect(after).toMatchObject({ name: DELETED_NAME_PLACEHOLDER, phone: deletedPhonePlaceholder(person.id) });
    expect(after.deletedAt).not.toBeNull();
    // Kept out of sight for the retention period, as the in-app delete does.
    expect(await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: person.id } })).toMatchObject({
      keptName: person.name,
      keptPhone: person.phone,
    });

    // Every step, by this admin, in order — the closing itself as account.delete.
    const rows = await auditRows(me.id);
    expect(rows.map((r) => r.action)).toEqual([
      "account_deletion.code_sent",
      "account_deletion.verify",
      "account.delete",
    ]);
    expect(rows.every((r) => r.target === person.id)).toBe(true);
    expect(rows.map((r) => r.reason)).toEqual([
      `${maskPhone(person.phone)}: code texted`,
      `${maskPhone(person.phone)}: code correct`,
      `${maskPhone(person.phone)}: emailed request, confirmed with a texted code`,
    ]);
  });

  it("deletes a driver the way the in-app delete does: offline, out of dispatch, plate and photo gone", async () => {
    const { auth } = await admin();
    const { user: driver } = await createTestDriver({ isOnline: true, isApproved: true });
    userIds.push(driver.id);

    const res = await remove(auth, driver.phone, await confirmed(auth, driver.phone));
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe("DRIVER");
    expect(await prisma.driver.findUniqueOrThrow({ where: { userId: driver.id } })).toMatchObject({
      isOnline: false,
      isApproved: false,
      plate: null,
      photoUrl: null,
    });
    expect((await prisma.accountDeletion.findUniqueOrThrow({ where: { userId: driver.id } })).keptPlate).not.toBeNull();
  });

  it("never writes the code or the full number to the audit log", async () => {
    const { user: me, auth } = await admin();
    const person = await rider();
    await sendCode(auth, person.phone);
    const code = otp.codeFor(person.phone);
    await verify(auth, person.phone, code === "000000" ? "111111" : "000000");
    await verify(auth, person.phone, code);

    const rows = await auditRows(me.id);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const written = JSON.stringify(row);
      expect(written).not.toContain(code);
      expect(written).not.toContain(person.phone);
      expect(written).not.toContain(person.phone.slice(4));
    }
  });
});

describe("only a right, unexpired code unlocks deleting", () => {
  it("a wrong code is refused and recorded; nothing is deleted", async () => {
    const { user: me, auth } = await admin();
    const person = await rider();
    await sendCode(auth, person.phone);
    const wrong = otp.codeFor(person.phone) === "000000" ? "111111" : "000000";

    const res = await verify(auth, person.phone, wrong);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn't right/);
    expect((await auditRows(me.id)).at(-1)).toMatchObject({
      action: "account_deletion.verify",
      reason: `${maskPhone(person.phone)}: wrong code`,
    });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).deletedAt).toBeNull();
  });

  it("an expired code is refused", async () => {
    const { auth } = await admin();
    const person = await rider();
    await sendCode(auth, person.phone);
    await prisma.otpCode.updateMany({ where: { phone: person.phone }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await verify(auth, person.phone, otp.codeFor(person.phone));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/expired/);
  });

  it("a login code doesn't count", async () => {
    const { auth } = await admin();
    const person = await rider();
    await prisma.otpCode.create({
      data: {
        phone: person.phone,
        purpose: "LOGIN",
        codeHash: sha256("424242"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await verify(auth, person.phone, "424242")).statusCode).toBe(400);
  });

  it("deleting without a confirmed code is refused and recorded", async () => {
    const { user: me, auth } = await admin();
    const person = await rider();

    const res = await remove(auth, person.phone, "not-a-token");
    expect(res.statusCode).toBe(400);
    expect((await auditRows(me.id)).at(-1)).toMatchObject({ action: "account_deletion.delete_refused" });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: person.id } })).deletedAt).toBeNull();
  });

  it("a confirmation is only good for the admin who checked the code, and that account", async () => {
    const first = await admin();
    const second = await admin();
    const person = await rider();
    const other = await rider();
    const token = await confirmed(first.auth, person.phone);

    expect((await remove(second.auth, person.phone, token)).statusCode).toBe(400);
    expect((await remove(first.auth, other.phone, token)).statusCode).toBe(400);
    expect(await prisma.user.count({ where: { id: { in: [person.id, other.id] }, deletedAt: { not: null } } })).toBe(0);
  });

  it("a confirmation can't be used twice", async () => {
    const { auth } = await admin();
    const person = await rider();
    const token = await confirmed(auth, person.phone);

    expect((await remove(auth, person.phone, token)).statusCode).toBe(200);
    expect((await remove(auth, person.phone, token)).statusCode).toBe(404);
  });

  it("uses the usual code limits: one code per number per cooldown", async () => {
    setRateLimitStore(new MemoryRateLimitStore(10_000, 0));
    const { user: me, auth } = await admin();
    const person = await rider();
    for (let i = 0; i < RULES.otpCooldown.max; i += 1) {
      expect((await sendCode(auth, person.phone)).statusCode).toBe(200);
    }
    expect((await sendCode(auth, person.phone)).statusCode).toBe(429);
    expect((await auditRows(me.id)).at(-1)).toMatchObject({
      action: "account_deletion.code_refused",
      reason: `${maskPhone(person.phone)}: rate limited`,
    });
  });
});

describe("refused, as in the app", () => {
  it("an admin account: shown as blocked, no code sent, can't be deleted", async () => {
    const { user: me, auth } = await admin();
    const { user: target } = await admin();

    expect((await lookUp(auth, target.phone)).json().blocked).toMatchObject({ reason: "admin" });
    const res = await sendCode(auth, target.phone);
    expect(res.statusCode).toBe(403);
    expect(await prisma.otpCode.count({ where: { phone: target.phone } })).toBe(0);
    expect((await auditRows(me.id)).at(-1)).toMatchObject({
      action: "account_deletion.code_refused",
      reason: `${maskPhone(target.phone)}: admin`,
    });

    // Even holding a confirmation (which the routes would never issue for it).
    const forged = signDeletionConfirmToken({ userId: target.id, phone: target.phone, actor: me.id });
    expect((await remove(auth, target.phone, forged)).statusCode).toBe(403);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).deletedAt).toBeNull();
  });

  it("a number on the admin allowlist, whatever its account's role", async () => {
    const { user: me, auth } = await admin();
    const person = await rider();
    allowlist.push(me.phone, person.phone);

    expect((await lookUp(auth, person.phone)).json().blocked).toMatchObject({ reason: "admin" });
    expect((await sendCode(auth, person.phone)).statusCode).toBe(403);
  });

  it("someone on a ride, rider or driver: no code is sent", async () => {
    const { auth } = await admin();
    const { user: driver } = await createTestDriver();
    const { ride, rider: onTrip } = await createTestRide({ type: "LONE", status: "MATCHED", driverId: driver.id });
    rideIds.push(ride.id);

    for (const person of [onTrip, driver]) {
      expect((await lookUp(auth, person.phone)).json().blocked).toMatchObject({ reason: "active_ride", rideId: ride.id });
      const res = await sendCode(auth, person.phone);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: expect.stringContaining("Finish or cancel it first"), rideId: ride.id });
    }
    expect(await prisma.otpCode.count({ where: { phone: { in: [onTrip.phone, driver.phone] } } })).toBe(0);
  });

  it("a ride that starts after the code was checked still stops the deletion", async () => {
    const { user: me, auth } = await admin();
    const { user: driver } = await createTestDriver();
    userIds.push(driver.id);
    const token = await confirmed(auth, driver.phone);
    const { ride } = await createTestRide({ type: "LONE", status: "IN_PROGRESS", driverId: driver.id });
    rideIds.push(ride.id);

    const res = await remove(auth, driver.phone, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().rideId).toBe(ride.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: driver.id } })).deletedAt).toBeNull();
    expect((await auditRows(me.id)).at(-1)).toMatchObject({
      action: "account_deletion.delete_refused",
      reason: `${maskPhone(driver.phone)}: active_ride`,
    });
  });
});
