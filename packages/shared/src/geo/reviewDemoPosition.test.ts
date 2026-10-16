import { describe, expect, it } from "vitest";
import { REVIEW_DEMO_POSITION } from "./reviewDemoPosition";
import { isInServiceArea } from "./serviceArea";

describe("REVIEW_DEMO_POSITION", () => {
  it("is on campus, so a reviewer anywhere can book and drive", () => {
    expect(isInServiceArea(REVIEW_DEMO_POSITION)).toBe(true);
  });
});
