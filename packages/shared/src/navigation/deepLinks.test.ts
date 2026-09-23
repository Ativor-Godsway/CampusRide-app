import { describe, it, expect } from "vitest";
import {
  DRIVER_DEEP_LINK_POLICY,
  RIDER_DEEP_LINK_POLICY,
  isAllowedDeepLink,
  parseDeepLinkPath,
} from "./deepLinks";

describe("parseDeepLinkPath", () => {
  it("rejoins the custom-scheme authority with the path", () => {
    // "ride" parses as the authority, not the path — Expo Router still routes
    // to /ride/abc, so both parts have to be kept.
    expect(parseDeepLinkPath("campusride-driver://ride/abc", "campusride-driver")).toBe("ride/abc");
  });

  it("handles the triple-slash form and trailing slashes", () => {
    expect(parseDeepLinkPath("campusride-rider:///rides", "campusride-rider")).toBe("rides");
    expect(parseDeepLinkPath("campusride-rider://rides/", "campusride-rider")).toBe("rides");
  });

  it("returns the empty path for a bare scheme launch", () => {
    expect(parseDeepLinkPath("campusride-rider://", "campusride-rider")).toBe("");
  });

  it("strips query and fragment", () => {
    expect(parseDeepLinkPath("campusride-rider://rides?next=x#frag", "campusride-rider")).toBe("rides");
  });

  it("is case-insensitive on the scheme only", () => {
    expect(parseDeepLinkPath("CampusRide-Rider://rides", "campusride-rider")).toBe("rides");
  });

  it("rejects a different scheme", () => {
    expect(parseDeepLinkPath("campusride-driver://rides", "campusride-rider")).toBeNull();
    expect(parseDeepLinkPath("https://evil.example/rides", "campusride-rider")).toBeNull();
  });

  it("rejects a scheme that merely starts with ours", () => {
    expect(parseDeepLinkPath("campusride-rider-evil://rides", "campusride-rider")).toBeNull();
  });

  it("rejects userinfo smuggling", () => {
    expect(parseDeepLinkPath("campusride-rider://evil.example@rides", "campusride-rider")).toBeNull();
  });

  it("rejects path traversal, encoded or not", () => {
    expect(parseDeepLinkPath("campusride-rider://../../secret", "campusride-rider")).toBeNull();
    expect(parseDeepLinkPath("campusride-rider://%2e%2e/secret", "campusride-rider")).toBeNull();
  });

  it("rejects double-encoded payloads", () => {
    // Decodes once to "%2e%2e/secret", which still contains '%'.
    expect(parseDeepLinkPath("campusride-rider://%252e%252e/secret", "campusride-rider")).toBeNull();
  });

  it("rejects malformed percent-encoding", () => {
    expect(parseDeepLinkPath("campusride-rider://%zz", "campusride-rider")).toBeNull();
  });

  it("rejects backslashes and control characters", () => {
    expect(parseDeepLinkPath("campusride-rider://rides\\..\\x", "campusride-rider")).toBeNull();
    expect(parseDeepLinkPath("campusride-rider://rides\u0000", "campusride-rider")).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseDeepLinkPath("", "campusride-rider")).toBeNull();
    expect(parseDeepLinkPath("not a url", "campusride-rider")).toBeNull();
    expect(parseDeepLinkPath(undefined as unknown as string, "campusride-rider")).toBeNull();
  });
});

describe("isAllowedDeepLink — rider", () => {
  const policy = RIDER_DEEP_LINK_POLICY;

  it("allows the listed routes", () => {
    expect(isAllowedDeepLink("campusride-rider://", policy)).toBe(true);
    expect(isAllowedDeepLink("campusride-rider://rides", policy)).toBe(true);
    expect(isAllowedDeepLink("campusride-rider://auth/otp", policy)).toBe(true);
  });

  it("blocks routes that are not on the allowlist", () => {
    // Reachable inside the app, but not something another app may launch.
    expect(isAllowedDeepLink("campusride-rider://ride/type", policy)).toBe(false);
    expect(isAllowedDeepLink("campusride-rider://account", policy)).toBe(false);
  });

  it("blocks the driver scheme", () => {
    expect(isAllowedDeepLink("campusride-driver://rides", policy)).toBe(false);
  });

  it("blocks extra path depth on an allowed prefix", () => {
    expect(isAllowedDeepLink("campusride-rider://rides/1/edit", policy)).toBe(false);
  });
});

describe("isAllowedDeepLink — driver", () => {
  const policy = DRIVER_DEEP_LINK_POLICY;

  it("allows a ride detail link with a sane id", () => {
    expect(isAllowedDeepLink("campusride-driver://ride/clx123abc", policy)).toBe(true);
  });

  it("rejects a ride id containing a path separator or traversal", () => {
    expect(isAllowedDeepLink("campusride-driver://ride/a/b", policy)).toBe(false);
    expect(isAllowedDeepLink("campusride-driver://ride/..", policy)).toBe(false);
  });

  it("rejects an over-long or oddly-charactered ride id", () => {
    expect(isAllowedDeepLink(`campusride-driver://ride/${"a".repeat(65)}`, policy)).toBe(false);
    expect(isAllowedDeepLink("campusride-driver://ride/<script>", policy)).toBe(false);
  });

  it("requires the param to be present", () => {
    expect(isAllowedDeepLink("campusride-driver://ride", policy)).toBe(false);
    expect(isAllowedDeepLink("campusride-driver://ride/", policy)).toBe(false);
  });
});
