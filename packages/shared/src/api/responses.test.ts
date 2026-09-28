import { describe, it, expect } from "vitest";
import { asArray, readCursorPage, readList } from "./responses";

describe("asArray", () => {
  it("passes arrays through untouched", () => {
    const list = [1, 2];
    expect(asArray(list)).toBe(list);
  });

  it.each([undefined, null, "rides", 3, { length: 2 }])("turns %p into []", (value) => {
    expect(asArray(value)).toEqual([]);
  });
});

describe("readList", () => {
  it("reads the named list", () => {
    expect(readList({ zones: [{ id: "a" }] }, "zones")).toEqual([{ id: "a" }]);
  });

  it("returns [] for a missing key, a non-array value or a non-object body", () => {
    expect(readList({}, "zones")).toEqual([]);
    expect(readList({ zones: null }, "zones")).toEqual([]);
    expect(readList(undefined, "zones")).toEqual([]);
    expect(readList("<html>Bad gateway</html>", "zones")).toEqual([]);
  });
});

describe("readCursorPage", () => {
  it("reads GET /rides/mine's page shape", () => {
    const page = readCursorPage(
      { rides: [{ id: "r1" }], nextCursor: "r1", hasMore: true },
      "rides",
    );
    expect(page).toEqual({ items: [{ id: "r1" }], nextCursor: "r1", hasMore: true });
  });

  it("treats a brand-new rider's empty page as the last page", () => {
    expect(readCursorPage({ rides: [], nextCursor: null, hasMore: false }, "rides")).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  it("never offers more pages without a cursor to fetch them with", () => {
    const page = readCursorPage({ rides: [], hasMore: true }, "rides");
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("survives the pre-pagination shape and a garbage body", () => {
    expect(readCursorPage([{ id: "r1" }], "rides").items).toEqual([]);
    expect(readCursorPage(undefined, "rides")).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });
});
