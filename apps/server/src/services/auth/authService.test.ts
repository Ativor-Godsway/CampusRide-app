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
import { InvalidRefreshTokenError, PhoneAlreadyRegisteredError, UserNotFoundError } from "./errors";
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
