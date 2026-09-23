import { describe, it, expect, afterEach, afterAll } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "../../db/prisma";
import { config } from "../../config";
import {
  completeDriverProfile,
  login,
  logout,
  refresh,
  revokeAllForUser,
  signup,
} from "./authService";
import {
  InvalidRefreshTokenError,
  PhoneAlreadyRegisteredError,
  RefreshTokenReuseError,
  UserNotFoundError,
} from "./errors";
import { signVerificationToken } from "./tokens";
import { sha256, generateRefreshTokenValue } from "./hash";
import { cleanupUser, uniqueTestPhone } from "./testFixtures";

const userIds: string[] = [];

afterEach(async () => {
  while (userIds.length > 0) {
    await cleanupUser(userIds.pop()!);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

function verifiedSignupToken(phone: string): string {
  return signVerificationToken({ phone, purpose: "SIGNUP" });
}

function verifiedLoginToken(phone: string): string {
  return signVerificationToken({ phone, purpose: "LOGIN" });
}

describe("signup", () => {
  it("creates a RIDER user and issues valid tokens", async () => {
    const phone = uniqueTestPhone();

    const result = await signup(prisma, {
      phone,
      name: "Ama Rider",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(result.user.id);

    expect(result.user.role).toBe("RIDER");
    expect(result.user.phone).toBe(phone);

    const decoded = jwt.verify(result.accessToken, config.jwtSecret) as {
      userId: string;
      role: string;
    };
    expect(decoded.userId).toBe(result.user.id);
    expect(decoded.role).toBe("RIDER");

    const stored = await prisma.refreshToken.findFirst({ where: { userId: result.user.id } });
    expect(stored).not.toBeNull();
    expect(stored!.tokenHash).toBe(sha256(result.refreshToken));
    expect(stored!.revokedAt).toBeNull();
  });

  it("creates a DRIVER user with a pending Driver row (isApproved=false)", async () => {
    const phone = uniqueTestPhone();

    const result = await signup(prisma, {
      phone,
      name: "Kofi Driver",
      role: "DRIVER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(result.user.id);

    const driver = await prisma.driver.findUnique({ where: { userId: result.user.id } });
    expect(driver).not.toBeNull();
    expect(driver!.isApproved).toBe(false);
    expect(driver!.carMake).toBeNull();
    expect(driver!.plate).toBeNull();
  });

  it("rejects signup for a phone that is already registered", async () => {
    const phone = uniqueTestPhone();

    const first = await signup(prisma, {
      phone,
      name: "First",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(first.user.id);

    await expect(
      signup(prisma, {
        phone,
        name: "Second",
        role: "RIDER",
        verifiedToken: verifiedSignupToken(phone),
      }),
    ).rejects.toThrow(PhoneAlreadyRegisteredError);
  });
});

describe("login", () => {
  it("succeeds for an existing user and issues valid tokens", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Existing User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    const result = await login(prisma, { phone, verifiedToken: verifiedLoginToken(phone) });

    expect(result.user.id).toBe(created.user.id);
    const decoded = jwt.verify(result.accessToken, config.jwtSecret) as { userId: string };
    expect(decoded.userId).toBe(created.user.id);
  });

  it("rejects login for an unknown phone", async () => {
    const phone = uniqueTestPhone();
    await expect(
      login(prisma, { phone, verifiedToken: verifiedLoginToken(phone) }),
    ).rejects.toThrow(UserNotFoundError);
  });
});

describe("refresh", () => {
  it("rotates a valid refresh token: issues new tokens and revokes the old one", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Refresh User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    const result = await refresh(prisma, created.refreshToken);

    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).not.toBe(created.refreshToken);

    const oldStored = await prisma.refreshToken.findFirst({
      where: { tokenHash: sha256(created.refreshToken) },
    });
    expect(oldStored!.revokedAt).not.toBeNull();

    const newStored = await prisma.refreshToken.findFirst({
      where: { tokenHash: sha256(result.refreshToken) },
    });
    expect(newStored).not.toBeNull();
    expect(newStored!.revokedAt).toBeNull();
  });

  it("rejects reuse of a rotated (revoked) refresh token", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Reuse User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    await refresh(prisma, created.refreshToken);

    await expect(refresh(prisma, created.refreshToken)).rejects.toThrow(InvalidRefreshTokenError);
  });

  it("rejects an expired refresh token", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Expired User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    const expiredToken = generateRefreshTokenValue();
    await prisma.refreshToken.create({
      data: {
        userId: created.user.id,
        tokenHash: sha256(expiredToken),
        expiresAt: new Date(Date.now() - 1000),
        // familyId is required since the Phase-2 rotation-chain migration;
        // a hand-built row is its own single-token family.
        familyId: "expired-token-family",
      },
    });

    await expect(refresh(prisma, expiredToken)).rejects.toThrow(InvalidRefreshTokenError);
  });

  it("rejects an unknown refresh token", async () => {
    await expect(refresh(prisma, generateRefreshTokenValue())).rejects.toThrow(
      InvalidRefreshTokenError,
    );
  });
});

describe("logout / revokeAllForUser", () => {
  it("logout revokes the token so it can no longer be refreshed", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Logout User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    await logout(prisma, created.refreshToken);

    await expect(refresh(prisma, created.refreshToken)).rejects.toThrow(InvalidRefreshTokenError);
    await expect(logout(prisma, created.refreshToken)).rejects.toThrow(InvalidRefreshTokenError);
  });

  it("revokeAllForUser revokes every active refresh token for the user", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "RevokeAll User",
      role: "RIDER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    const second = await refresh(prisma, created.refreshToken);

    await revokeAllForUser(prisma, created.user.id);

    await expect(refresh(prisma, second.refreshToken)).rejects.toThrow(InvalidRefreshTokenError);
  });
});

describe("completeDriverProfile", () => {
  it("fills in the Driver row created at signup", async () => {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Profile Driver",
      role: "DRIVER",
      verifiedToken: verifiedSignupToken(phone),
    });
    userIds.push(created.user.id);

    const driver = await completeDriverProfile(prisma, created.user.id, {
      carMake: "Toyota",
      carModel: "Vitz",
      carColor: "Silver",
      plate: "GR-1234-26",
      photoUrl: "https://placeholder.example.com/photo.jpg",
    });

    expect(driver.carMake).toBe("Toyota");
    expect(driver.plate).toBe("GR-1234-26");
    expect(driver.photoUrl).toBe("https://placeholder.example.com/photo.jpg");
  });
});

describe("refresh — rotation chains and reuse detection (Phase 2)", () => {
  /** Signs a user up and returns them plus their first refresh token. */
  async function newSession() {
    const phone = uniqueTestPhone();
    const created = await signup(prisma, {
      phone,
      name: "Rotation User",
      role: "RIDER",
      verifiedToken: signVerificationToken({ phone, purpose: "SIGNUP" }),
    });
    userIds.push(created.user.id);
    return created;
  }

  it("keeps every rotated token in one family", async () => {
    const session = await newSession();

    const second = await refresh(prisma, session.refreshToken);
    const third = await refresh(prisma, second.refreshToken);

    const rows = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    expect(rows).toHaveLength(3);
    const families = new Set(rows.map((r) => r.familyId));
    expect(families.size).toBe(1);

    // The family root is the token issued at signup, and it is a real id.
    const [familyId] = [...families];
    expect(rows.some((r) => r.id === familyId)).toBe(true);
    expect(third.refreshToken).toBeTruthy();
  });

  it("a separate login starts a separate family", async () => {
    const a = await newSession();
    const b = await newSession();

    const rowA = await prisma.refreshToken.findFirstOrThrow({ where: { userId: a.user.id } });
    const rowB = await prisma.refreshToken.findFirstOrThrow({ where: { userId: b.user.id } });
    expect(rowA.familyId).not.toBe(rowB.familyId);
  });

  it("treats reuse of a consumed token as theft and revokes the whole family", async () => {
    const session = await newSession();

    // Legitimate rotation: token1 -> token2 -> token3.
    const second = await refresh(prisma, session.refreshToken);
    const third = await refresh(prisma, second.refreshToken);

    // An attacker replays the first (already consumed) token.
    await expect(refresh(prisma, session.refreshToken)).rejects.toThrow(RefreshTokenReuseError);

    // Everything in the chain is now revoked — including token3, which the
    // legitimate client was still holding. Both parties must re-authenticate.
    const rows = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

    await expect(refresh(prisma, third.refreshToken)).rejects.toThrow(InvalidRefreshTokenError);
  });

  it("reuse detection reports the owning user, for logging", async () => {
    const session = await newSession();
    await refresh(prisma, session.refreshToken);

    await expect(refresh(prisma, session.refreshToken)).rejects.toMatchObject({
      name: "RefreshTokenReuseError",
      userId: session.user.id,
    });
  });

  it("RefreshTokenReuseError is an InvalidRefreshTokenError, so the route still answers 401", async () => {
    const session = await newSession();
    await refresh(prisma, session.refreshToken);

    const err = await refresh(prisma, session.refreshToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRefreshTokenError);
    // Identical message to an ordinary invalid token — no oracle for the attacker.
    expect((err as Error).message).toBe("Refresh token is invalid, revoked, or expired");
  });

  it("does not touch other users' tokens when a family is burned", async () => {
    const victim = await newSession();
    const bystander = await newSession();

    await refresh(prisma, victim.refreshToken);
    await expect(refresh(prisma, victim.refreshToken)).rejects.toThrow(RefreshTokenReuseError);

    const bystanderRows = await prisma.refreshToken.findMany({
      where: { userId: bystander.user.id },
    });
    expect(bystanderRows.every((r) => r.revokedAt === null)).toBe(true);
    // And the bystander's token still works.
    await expect(refresh(prisma, bystander.refreshToken)).resolves.toHaveProperty("accessToken");
  });

  it("an unknown token is rejected without burning anything", async () => {
    const session = await newSession();

    await expect(refresh(prisma, generateRefreshTokenValue())).rejects.toThrow(
      InvalidRefreshTokenError,
    );

    const rows = await prisma.refreshToken.findMany({ where: { userId: session.user.id } });
    expect(rows.every((r) => r.revokedAt === null)).toBe(true);
  });

  it("an expired token is rejected as invalid, not as theft", async () => {
    const session = await newSession();
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365);

    const err = await refresh(prisma, session.refreshToken, future).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvalidRefreshTokenError);
    expect(err).not.toBeInstanceOf(RefreshTokenReuseError);
  });
});
