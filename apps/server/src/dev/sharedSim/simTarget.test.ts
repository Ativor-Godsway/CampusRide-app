import { describe, expect, it } from "vitest";
import { assertSimTargetIsLocal } from "./simTarget";

const local = "postgresql://me@localhost:5432/rida_dev";

describe("simulate:shared runs on a local database only", () => {
  it("allows local Postgres", () => {
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: local, DIRECT_URL: local })).not.toThrow();
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: "postgresql://me@127.0.0.1/rida_test" })).not.toThrow();
  });

  it("refuses the production database by name, wherever it appears", () => {
    const prod = "postgresql://u:p@ep-empty-violet-bay5yr3y-pooler.eu-central-1.aws.neon.tech/neondb";
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: prod })).toThrow(/PRODUCTION database/);
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: local, DIRECT_URL: prod })).toThrow(/PRODUCTION database/);
  });

  it("refuses any other remote database, including the dev branch", () => {
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: "postgresql://u@ep-flat-rain-x.neon.tech/db" })).toThrow(/not a local Postgres/);
    expect(() => assertSimTargetIsLocal({})).toThrow(/not set/);
  });

  it("refuses the production API URL", () => {
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: local, PUBLIC_BASE_URL: "https://api.campusride.app" })).toThrow(
      /production API/,
    );
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: local, SIM_API_URL: "https://API.campusride.app/x" })).toThrow(/production API/);
  });

  it("refuses NODE_ENV=production", () => {
    expect(() => assertSimTargetIsLocal({ DATABASE_URL: local, NODE_ENV: "production" })).toThrow(/production/);
  });
});
