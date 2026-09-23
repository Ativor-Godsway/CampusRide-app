import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  ALLOWED_IMAGE_FORMATS,
  DRIVER_PHOTO_FOLDER,
  buildDriverPhotoUploadTicket,
  buildSignature,
  driverPhotoPublicId,
  isValidDriverPhotoUrl,
} from "./cloudinarySignature";

const CFG = { cloudName: "campusride", apiKey: "123456789", apiSecret: "super-secret" };

describe("buildSignature", () => {
  it("matches Cloudinary's documented algorithm (sorted k=v joined by &, + secret, sha1)", () => {
    const params = { timestamp: 1700000000, public_id: "abc", folder: "f" };
    const expected = createHash("sha1")
      .update("folder=f&public_id=abc&timestamp=1700000000" + CFG.apiSecret)
      .digest("hex");

    expect(buildSignature(params, CFG.apiSecret)).toBe(expected);
  });

  it("is order-independent in the input object", () => {
    const a = buildSignature({ b: 2, a: 1 }, CFG.apiSecret);
    const b = buildSignature({ a: 1, b: 2 }, CFG.apiSecret);
    expect(a).toBe(b);
  });

  it("changes when any parameter changes", () => {
    const base = buildSignature({ timestamp: 1, public_id: "x" }, CFG.apiSecret);
    expect(buildSignature({ timestamp: 2, public_id: "x" }, CFG.apiSecret)).not.toBe(base);
    expect(buildSignature({ timestamp: 1, public_id: "y" }, CFG.apiSecret)).not.toBe(base);
  });

  it("changes when the secret changes", () => {
    const params = { timestamp: 1 };
    expect(buildSignature(params, "secret-a")).not.toBe(buildSignature(params, "secret-b"));
  });
});

describe("buildDriverPhotoUploadTicket", () => {
  it("pins folder, public id, formats and transformation into the SIGNED params", () => {
    const ticket = buildDriverPhotoUploadTicket(CFG, "user-1", 1700000000);

    expect(ticket.params.folder).toBe(DRIVER_PHOTO_FOLDER);
    expect(ticket.params.public_id).toBe("driver_user-1");
    expect(ticket.params.allowed_formats).toBe(ALLOWED_IMAGE_FORMATS.join(","));
    expect(ticket.params.transformation).toContain("c_limit");
    expect(ticket.params.timestamp).toBe(1700000000);

    // The signature covers exactly those params, so a client that edits any
    // of them (e.g. to escape the folder) gets rejected by Cloudinary.
    expect(ticket.signature).toBe(buildSignature(ticket.params, CFG.apiSecret));
  });

  it("never returns the API secret", () => {
    const ticket = buildDriverPhotoUploadTicket(CFG, "user-1", 1700000000);
    expect(JSON.stringify(ticket)).not.toContain(CFG.apiSecret);
  });

  it("gives each driver a distinct public id, so one cannot overwrite another", () => {
    const a = buildDriverPhotoUploadTicket(CFG, "user-a", 1700000000);
    const b = buildDriverPhotoUploadTicket(CFG, "user-b", 1700000000);

    expect(a.params.public_id).not.toBe(b.params.public_id);
    expect(a.signature).not.toBe(b.signature);
  });

  it("produces a new signature per timestamp, bounding how long a ticket is useful", () => {
    const a = buildDriverPhotoUploadTicket(CFG, "user-1", 1700000000);
    const b = buildDriverPhotoUploadTicket(CFG, "user-1", 1700000060);
    expect(a.signature).not.toBe(b.signature);
  });

  it("targets this account's upload endpoint", () => {
    const ticket = buildDriverPhotoUploadTicket(CFG, "user-1", 1700000000);
    expect(ticket.uploadUrl).toBe("https://api.cloudinary.com/v1_1/campusride/image/upload");
  });
});

describe("isValidDriverPhotoUrl", () => {
  const good = `https://res.cloudinary.com/campusride/image/upload/v1/${DRIVER_PHOTO_FOLDER}/${driverPhotoPublicId("user-1")}.jpg`;

  it("accepts a genuine upload for that driver", () => {
    expect(isValidDriverPhotoUrl(good, "campusride", "user-1")).toBe(true);
  });

  it("rejects an arbitrary third-party URL", () => {
    expect(isValidDriverPhotoUrl("https://evil.example/pic.jpg", "campusride", "user-1")).toBe(false);
  });

  it("rejects another Cloudinary account", () => {
    const other = good.replace("res.cloudinary.com/campusride", "res.cloudinary.com/someoneelse");
    expect(isValidDriverPhotoUrl(other, "campusride", "user-1")).toBe(false);
  });

  it("rejects another driver's photo", () => {
    expect(isValidDriverPhotoUrl(good, "campusride", "user-2")).toBe(false);
  });

  it("rejects a lookalike host", () => {
    const spoof = good.replace("res.cloudinary.com", "res.cloudinary.com.evil.example");
    expect(isValidDriverPhotoUrl(spoof, "campusride", "user-1")).toBe(false);
  });

  it("rejects plain http", () => {
    expect(isValidDriverPhotoUrl(good.replace("https://", "http://"), "campusride", "user-1")).toBe(
      false,
    );
  });
});
