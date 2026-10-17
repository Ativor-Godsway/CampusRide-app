import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import {
  signAccessToken,
  signDeletionConfirmToken,
  signVerificationToken,
  verifyAccessToken,
  verifyDeletionConfirmToken,
  verifyVerificationToken,
} from "./tokens";
import { InvalidVerificationTokenError } from "./errors";

const PHONE = "+233241234567";

describe("access and verification tokens can't stand in for each other", () => {
  it("an OTP verification token is not an access token", () => {
    expect(() =>
      verifyAccessToken(signVerificationToken({ phone: PHONE, purpose: "LOGIN" })),
    ).toThrow();
  });

  it("an access token is not a verification token", () => {
    expect(() =>
      verifyVerificationToken(signAccessToken({ userId: "u1", role: "RIDER" }), PHONE, "LOGIN"),
    ).toThrow(InvalidVerificationTokenError);
  });

  it("a pre-`typ` verification token (phone + purpose, no userId) is still refused as an access token", () => {
    const legacy = jwt.sign({ phone: PHONE, purpose: "LOGIN" }, config.jwtSecret, {
      expiresIn: "5m",
    });
    expect(() => verifyAccessToken(legacy)).toThrow();
  });

  it("a pre-`typ` access token is accepted on its shape until it expires", () => {
    const legacy = jwt.sign({ userId: "u1", role: "DRIVER" }, config.jwtSecret, {
      expiresIn: "30m",
    });
    expect(verifyAccessToken(legacy)).toEqual({ userId: "u1", role: "DRIVER" });
  });
});

describe("verifyAccessToken", () => {
  it("returns only userId and role", () => {
    expect(verifyAccessToken(signAccessToken({ userId: "u1", role: "ADMIN" }))).toEqual({
      userId: "u1",
      role: "ADMIN",
    });
  });

  it("refuses unknown roles, empty ids, other algorithms and other secrets", () => {
    const bad = [
      jwt.sign({ userId: "u1", role: "SUPERUSER", typ: "access" }, config.jwtSecret),
      jwt.sign({ userId: "", role: "RIDER", typ: "access" }, config.jwtSecret),
      jwt.sign({ userId: "u1", role: "RIDER", typ: "access" }, config.jwtSecret, {
        algorithm: "HS512",
      }),
      jwt.sign({ userId: "u1", role: "RIDER", typ: "access" }, "another-secret"),
      jwt.sign({ userId: "u1", role: "RIDER", typ: "refresh" }, config.jwtSecret),
      [
        Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url"),
        Buffer.from('{"userId":"u1","role":"ADMIN"}').toString("base64url"),
        "",
      ].join("."),
    ];
    for (const token of bad) expect(() => verifyAccessToken(token)).toThrow();
  });
});

describe("an admin's deletion confirm token", () => {
  const payload = { userId: "u1", phone: PHONE, actor: "admin1" };

  it("confirms the account it was issued for, to the admin who checked the code", () => {
    expect(verifyDeletionConfirmToken(signDeletionConfirmToken(payload), { phone: PHONE, actor: "admin1" })).toEqual(
      payload,
    );
  });

  it("is refused for another phone or another admin", () => {
    const token = signDeletionConfirmToken(payload);
    expect(() => verifyDeletionConfirmToken(token, { phone: "+233241234568", actor: "admin1" })).toThrow(
      InvalidVerificationTokenError,
    );
    expect(() => verifyDeletionConfirmToken(token, { phone: PHONE, actor: "admin2" })).toThrow(
      InvalidVerificationTokenError,
    );
  });

  it("can't stand in for an access token or an OTP verification token, nor they for it", () => {
    const token = signDeletionConfirmToken(payload);
    expect(() => verifyAccessToken(token)).toThrow();
    expect(() => verifyVerificationToken(token, PHONE, "ACCOUNT_DELETION")).toThrow(InvalidVerificationTokenError);
    expect(() =>
      verifyDeletionConfirmToken(signVerificationToken({ phone: PHONE, purpose: "ACCOUNT_DELETION" }), {
        phone: PHONE,
        actor: "admin1",
      }),
    ).toThrow(InvalidVerificationTokenError);
    expect(() =>
      verifyDeletionConfirmToken(signAccessToken({ userId: "u1", role: "ADMIN" }), { phone: PHONE, actor: "admin1" }),
    ).toThrow(InvalidVerificationTokenError);
  });

  it("runs out", () => {
    const expired = jwt.sign({ ...payload, typ: "admin-deletion-confirmed" }, config.jwtSecret, {
      expiresIn: -1,
    });
    expect(() => verifyDeletionConfirmToken(expired, { phone: PHONE, actor: "admin1" })).toThrow(
      InvalidVerificationTokenError,
    );
  });
});
