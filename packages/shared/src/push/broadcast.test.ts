import { describe, expect, it } from "vitest";
import {
  BROADCAST_BODY_MAX,
  BROADCAST_TITLE_MAX,
  LAUNCH_PUSH_TEXT,
  checkBroadcastText,
  isAnnouncementPushData,
} from "./broadcast";

describe("checkBroadcastText", () => {
  it("trims, and keeps line breaks in the message", () => {
    expect(checkBroadcastText({ title: "  Hello  ", body: " Line one\r\nLine two " })).toEqual({
      ok: true,
      text: { title: "Hello", body: "Line one\nLine two" },
    });
  });

  it("allows exactly the limits and refuses one more", () => {
    const title = "t".repeat(BROADCAST_TITLE_MAX);
    const body = "b".repeat(BROADCAST_BODY_MAX);
    expect(checkBroadcastText({ title, body }).ok).toBe(true);
    expect(checkBroadcastText({ title: `${title}t`, body })).toEqual({
      ok: false,
      error: `The title can be at most ${BROADCAST_TITLE_MAX} characters.`,
    });
    expect(checkBroadcastText({ title, body: `${body}b` })).toEqual({
      ok: false,
      error: `The message can be at most ${BROADCAST_BODY_MAX} characters.`,
    });
  });

  it("refuses empty text, a multi-line title and control characters", () => {
    expect(checkBroadcastText({ title: " ", body: "x" }).ok).toBe(false);
    expect(checkBroadcastText({ title: "x", body: "" }).ok).toBe(false);
    expect(checkBroadcastText({ title: 5, body: "x" }).ok).toBe(false);
    expect(checkBroadcastText({ title: "a\nb", body: "x" }).ok).toBe(false);
    expect(checkBroadcastText({ title: "a", body: `x${String.fromCharCode(7)}y` }).ok).toBe(false);
  });

  it("the launch push fits its own limits", () => {
    expect(checkBroadcastText(LAUNCH_PUSH_TEXT)).toEqual({ ok: true, text: LAUNCH_PUSH_TEXT });
  });
});

describe("isAnnouncementPushData", () => {
  it("is true only for an admin notification's data", () => {
    expect(isAnnouncementPushData({ kind: "ANNOUNCEMENT" })).toBe(true);
    expect(isAnnouncementPushData({ kind: "TRIP_STARTED", rideId: "r1" })).toBe(false);
    expect(isAnnouncementPushData({})).toBe(false);
    expect(isAnnouncementPushData(null)).toBe(false);
    expect(isAnnouncementPushData("ANNOUNCEMENT")).toBe(false);
  });
});
