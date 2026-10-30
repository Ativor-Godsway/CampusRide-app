import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../../config";

/**
 * Admin passkeys: Face ID / Touch ID sign-in to the admin site (WebAuthn,
 * with @simplewebauthn/server). The main way in; a phone code stays as a
 * fallback only for admins with no passkey, or for everyone while
 * ADMIN_OTP_FALLBACK=on (recovery).
 *
 * - A passkey is added by an admin who is already signed in, for their own
 *   account only. Only its public key is stored.
 * - Signing in needs no phone number: the browser offers this site's
 *   passkeys, and the one chosen names the account. That account must still
 *   be an open ADMIN on ADMIN_PHONE_ALLOWLIST (authService.loginVerifiedAdmin).
 * - Every passkey works only on the admin site's own address
 *   (config.adminPasskeys.rpId), so a look-alike phishing site gets nothing.
 * - Challenges are single-use, live CHALLENGE_TTL_MS, and are kept in this
 *   server's memory (one instance; a restart just means trying again).
 */

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGES = 1_000;

type Purpose = "register" | "login";
const challenges = new Map<string, { challenge: string; purpose: Purpose; userId: string | null; expiresAt: number }>();

function keepChallenge(challenge: string, purpose: Purpose, userId: string | null): string {
  const now = Date.now();
  for (const [id, c] of challenges) if (c.expiresAt <= now) challenges.delete(id);
  if (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
  const id = randomUUID();
  challenges.set(id, { challenge, purpose, userId, expiresAt: now + CHALLENGE_TTL_MS });
  return id;
}

/** Takes (and forgets) a challenge; null if unknown, expired, or for something else. */
function takeChallenge(id: string, purpose: Purpose, userId: string | null): string | null {
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.purpose !== purpose || c.expiresAt <= Date.now() || c.userId !== userId) return null;
  return c.challenge;
}

/** A passkey step that didn't work; `reason` goes in the admin sign-in record. */
export class PasskeyError extends Error {
  constructor(
    message: string,
    readonly reason: "expired" | "unknown_passkey" | "not_verified",
  ) {
    super(message);
    this.name = "PasskeyError";
  }
}

const STALE = "That took too long. Please try again.";

/** Whether this admin must sign in with a passkey (has one, and the code fallback is off). */
export async function adminNeedsPasskey(prisma: PrismaClient, userId: string): Promise<boolean> {
  if (config.adminPasskeys.otpFallback) return false;
  return (await prisma.adminPasskey.count({ where: { userId } })) > 0;
}

export interface PasskeySummary {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(prisma: PrismaClient, userId: string): Promise<PasskeySummary[]> {
  const rows = await prisma.adminPasskey.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    backedUp: r.backedUp,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  }));
}

/** Options for adding a passkey to this (signed-in) admin's account. */
export async function registrationOptions(
  prisma: PrismaClient,
  userId: string,
): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true } });
  const existing = await prisma.adminPasskey.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
  const options = await generateRegistrationOptions({
    rpName: config.adminPasskeys.rpName,
    rpID: config.adminPasskeys.rpId,
    userName: user.name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: p.transports ? (p.transports.split(",") as never[]) : undefined,
    })),
    // A passkey the browser can offer by itself (no phone number typed), with Face ID / Touch ID.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  return { challengeId: keepChallenge(options.challenge, "register", userId), options };
}

/** Checks the browser's answer and keeps the new passkey. Audit row "admin.passkey.add". */
export async function addPasskey(
  prisma: PrismaClient,
  userId: string,
  input: { challengeId: string; response: RegistrationResponseJSON; name: string },
): Promise<PasskeySummary> {
  const challenge = takeChallenge(input.challengeId, "register", userId);
  if (!challenge) throw new PasskeyError(STALE, "expired");
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: config.adminPasskeys.origins,
      expectedRPID: config.adminPasskeys.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("That passkey couldn't be added. Please try again.", "not_verified");
  }
  if (!verified.verified) throw new PasskeyError("That passkey couldn't be added. Please try again.", "not_verified");
  const info = verified.registrationInfo;
  const name = input.name.trim().slice(0, 60) || "Passkey";
  const [row] = await prisma.$transaction([
    prisma.adminPasskey.create({
      data: {
        userId,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports?.join(",") ?? null,
        backedUp: info.credentialBackedUp,
        name,
      },
    }),
    prisma.adminAuditLog.create({ data: { actor: userId, action: "admin.passkey.add", target: userId, reason: name } }),
  ]);
  return (await listPasskeys(prisma, userId)).find((p) => p.id === row.id)!;
}

/** Removes one of this admin's own passkeys. Audit row "admin.passkey.remove". False if not theirs. */
export async function removePasskey(prisma: PrismaClient, userId: string, id: string): Promise<boolean> {
  const row = await prisma.adminPasskey.findFirst({ where: { id, userId }, select: { id: true, name: true } });
  if (!row) return false;
  await prisma.$transaction([
    prisma.adminPasskey.delete({ where: { id: row.id } }),
    prisma.adminAuditLog.create({ data: { actor: userId, action: "admin.passkey.remove", target: userId, reason: row.name } }),
  ]);
  return true;
}

/** Options for signing in with a passkey: any passkey of this site the browser holds. */
export async function loginOptions(): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({
    rpID: config.adminPasskeys.rpId,
    userVerification: "required",
  });
  return { challengeId: keepChallenge(options.challenge, "login", null), options };
}

/**
 * Checks a passkey sign-in and returns the account it proves (the caller
 * then checks it may use the admin site and starts the session).
 */
export async function verifyPasskeyLogin(
  prisma: PrismaClient,
  input: { challengeId: string; response: AuthenticationResponseJSON },
): Promise<{ userId: string }> {
  const challenge = takeChallenge(input.challengeId, "login", null);
  if (!challenge) throw new PasskeyError(STALE, "expired");
  const passkey = await prisma.adminPasskey.findUnique({ where: { credentialId: input.response.id } });
  if (!passkey) throw new PasskeyError("This passkey isn't registered here. Sign in with a phone code, then add it.", "unknown_passkey");
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge,
      expectedOrigin: config.adminPasskeys.origins,
      expectedRPID: config.adminPasskeys.rpId,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports ? (passkey.transports.split(",") as never[]) : undefined,
      },
      requireUserVerification: true,
    });
  } catch {
    throw new PasskeyError("That didn't work. Please try again.", "not_verified");
  }
  if (!verified.verified) throw new PasskeyError("That didn't work. Please try again.", "not_verified");
  await prisma.adminPasskey.update({
    where: { id: passkey.id },
    data: {
      counter: BigInt(verified.authenticationInfo.newCounter),
      backedUp: verified.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    },
  });
  return { userId: passkey.userId };
}

/** Tests only. */
export function resetPasskeyChallengesForTests(): void {
  challenges.clear();
}
