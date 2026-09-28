import { describe, it, expect } from "vitest";
import { cloudinaryAvatar } from "./cloudinaryAvatar";

const ORIGINAL =
  "https://res.cloudinary.com/demo/image/upload/v1712345678/campusride/driver-photos/driver_abc.jpg";

describe("cloudinaryAvatar", () => {
  it("injects a 2x face-cropped transform right after /upload/", () => {
    expect(cloudinaryAvatar(ORIGINAL, 48)).toBe(
      "https://res.cloudinary.com/demo/image/upload/w_96,h_96,c_fill,g_face,f_auto,q_auto/v1712345678/campusride/driver-photos/driver_abc.jpg",
    );
  });

  it("is idempotent", () => {
    const once = cloudinaryAvatar(ORIGINAL, 48);
    expect(cloudinaryAvatar(once, 48)).toBe(once);
  });

  it("leaves a local picker file untouched, even one whose path contains /upload/", () => {
    const local = "file:///data/user/0/host.exp.exponent/cache/upload/photo.jpg";
    expect(cloudinaryAvatar(local, 48)).toBe(local);
  });

  it("leaves other hosts and lookalike hosts untouched", () => {
    expect(cloudinaryAvatar("https://example.com/image/upload/a.jpg", 48)).toBe(
      "https://example.com/image/upload/a.jpg",
    );
    const spoof = "https://res.cloudinary.com.evil.example/x/image/upload/a.jpg";
    expect(cloudinaryAvatar(spoof, 48)).toBe(spoof);
  });

  it("passes empty and non-string input through without throwing", () => {
    expect(cloudinaryAvatar("", 48)).toBe("");
    expect(cloudinaryAvatar(undefined as unknown as string, 48)).toBeUndefined();
  });
});
