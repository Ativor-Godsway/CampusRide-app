import { describe, expect, it } from "vitest";
import { classifyActionFailure, refusalMessage } from "./actionFailure";

describe("classifyActionFailure", () => {
  it("retries when nothing reached the server or it hiccuped", () => {
    for (const s of [undefined, null, 0, 500, 502, 503, 504, 429, 408]) expect(classifyActionFailure(s)).toBe("retry");
  });

  it("treats every other 4xx as a real refusal", () => {
    for (const s of [400, 403, 404, 409]) expect(classifyActionFailure(s)).toBe("refused");
  });
});

describe("refusalMessage", () => {
  it("prefers the server's reason and never says 'reverted'", () => {
    expect(refusalMessage("This rider already cancelled.", "x")).toBe("This rider already cancelled.");
    expect(refusalMessage("  ", "Couldn't drop off Ama.")).toBe("Couldn't drop off Ama.");
  });
});
