import { describe, expect, it } from "vitest";
import { assertPhase2Database } from "./phase2Guard";

const url = (host: string) => `postgresql://user:secret@${host}/neondb?sslmode=require`;

describe("the Phase 2 test guard", () => {
  it("refuses the production endpoint, pooled or direct, wherever it appears", () => {
    expect(() => assertPhase2Database(url("ep-empty-violet-bay5yr3y-pooler.c-2.eu-central-1.aws.neon.tech"), "t")).toThrow(/PRODUCTION/);
    expect(() => assertPhase2Database(url("ep-empty-violet-bay5yr3y.c-2.eu-central-1.aws.neon.tech"), "t")).toThrow(/PRODUCTION/);
    expect(() => assertPhase2Database(url("ep-tiny-bread-bazvjtbb.x.neon.tech") + "&h=ep-empty-violet-bay5yr3y", "t")).toThrow(/PRODUCTION/);
  });

  it("refuses other production hosts, other branches, local databases and a bad URL", () => {
    expect(() => assertPhase2Database(url("ep-ancient-butterfly-1.neon.tech"), "t")).toThrow(/PRODUCTION/);
    expect(() => assertPhase2Database(url("ep-flat-rain-apsyo6mp.neon.tech"), "t")).toThrow(/phase2-test/);
    expect(() => assertPhase2Database(url("localhost:5432"), "t")).toThrow(/phase2-test/);
    expect(() => assertPhase2Database("", "t")).toThrow(/missing/);
  });

  it("allows the phase2-test branch, pooled or direct", () => {
    expect(() => assertPhase2Database(url("ep-tiny-bread-bazvjtbb-pooler.c-8.eu-central-1.aws.neon.tech"), "t")).not.toThrow();
    expect(() => assertPhase2Database(url("ep-tiny-bread-bazvjtbb.c-8.eu-central-1.aws.neon.tech"), "t")).not.toThrow();
  });
});
