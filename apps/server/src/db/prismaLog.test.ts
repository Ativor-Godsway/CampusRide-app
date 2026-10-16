import { describe, expect, it } from "vitest";
import { prismaLogLevels } from "./prisma";

describe("Prisma's query log", () => {
  it("is off in production and tests, on for local development", () => {
    expect(prismaLogLevels({ NODE_ENV: "production" })).toEqual(["error", "warn"]);
    expect(prismaLogLevels({ NODE_ENV: "test" })).toEqual(["error", "warn"]);
    expect(prismaLogLevels({ NODE_ENV: "development" })).toEqual(["query", "error", "warn"]);
  });

  it("can be switched on or off explicitly", () => {
    expect(prismaLogLevels({ NODE_ENV: "production", PRISMA_QUERY_LOG: "true" })).toEqual([
      "query",
      "error",
      "warn",
    ]);
    expect(prismaLogLevels({ NODE_ENV: "development", PRISMA_QUERY_LOG: "false" })).toEqual([
      "error",
      "warn",
    ]);
  });
});
