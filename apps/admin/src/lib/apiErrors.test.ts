/** A failed request says which section failed and the HTTP status, and never claims the server is down. */
import { describe, expect, it } from "vitest";
import { ApiError, failureText, noAnswerMessage } from "../api";

describe("error messages", () => {
  it("name the request that got no answer, without its query (it can hold a phone number)", () => {
    const text = noAnswerMessage("put", "/admin/launch/push?phone=0241234567");
    expect(text).toBe("No answer from the API for PUT /admin/launch/push: the browser blocked the request or the connection dropped");
    expect(text).not.toMatch(/server running|0241234567/);
  });

  it("say which section failed and the HTTP status", () => {
    expect(failureText("Saving launch mode", new ApiError("Admin role required", 403))).toBe("Saving launch mode failed: Admin role required (HTTP 403)");
    expect(failureText("Removing a passkey", new ApiError(noAnswerMessage("DELETE", "/admin/passkeys/abc"), 0))).toBe(
      "Removing a passkey failed: No answer from the API for DELETE /admin/passkeys/abc: the browser blocked the request or the connection dropped (no HTTP response)",
    );
    expect(failureText("Loading the audit log", new Error("boom"))).toBe("Loading the audit log failed: something went wrong");
  });
});
