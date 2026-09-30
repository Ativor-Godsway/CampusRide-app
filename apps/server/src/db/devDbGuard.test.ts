/**
 * The dev-tool guard (simulator, its cleanup, sim:approve-driver,
 * db:deploy:dev). Unlike dbHostGuard, it has NO production escape hatch:
 * these tools fabricate accounts and delete rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { KNOWN_PROD_DB_HOSTS } from "./dbHostGuard";
import { assertDevelopmentEnv, assertDevOnlyDatabase, assertLocalApiUrl } from "./devDbGuard";

const CTX = "test";
const saved = { prod: process.env.ALLOW_PRODUCTION_DB, test: process.env.ALLOW_TEST_DB_HOST };
afterEach(() => {
  if (saved.prod === undefined) delete process.env.ALLOW_PRODUCTION_DB;
  else process.env.ALLOW_PRODUCTION_DB = saved.prod;
  if (saved.test === undefined) delete process.env.ALLOW_TEST_DB_HOST;
  else process.env.ALLOW_TEST_DB_HOST = saved.test;
});

const prodHost = "ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech";
const prodUrl = `postgresql://u:p@${prodHost}/neondb?sslmode=require`;
const devUrl = "postgresql://u:p@ep-flat-rain-apsyo6mp-pooler.c-7.us-east-1.aws.neon.tech/neondb";
const devDirectUrl = "postgresql://u:p@ep-flat-rain-apsyo6mp.c-7.us-east-1.aws.neon.tech/neondb";

describe("assertDevOnlyDatabase", () => {
  it("allows local Postgres and the dev Neon branch (pooled and direct)", () => {
    for (const url of ["postgresql://u:p@localhost:5432/rida", "postgresql://u:p@127.0.0.1/rida", devUrl, devDirectUrl]) {
      expect(() => assertDevOnlyDatabase(url, CTX), url).not.toThrow();
    }
  });

  it("refuses every known production host", () => {
    for (const prod of KNOWN_PROD_DB_HOSTS) {
      const url = `postgresql://u:p@${prod}-xyz-pooler.c-7.us-east-1.aws.neon.tech/neondb`;
      expect(() => assertDevOnlyDatabase(url, CTX)).toThrow(/PRODUCTION database/);
    }
  });

  it("refuses production even with ALLOW_PRODUCTION_DB=1 — the escape hatch does not apply", () => {
    process.env.ALLOW_PRODUCTION_DB = "1";
    expect(() => assertDevOnlyDatabase(prodUrl, CTX)).toThrow(/PRODUCTION database/);
  });

  it("refuses production even when it is named in ALLOW_TEST_DB_HOST", () => {
    process.env.ALLOW_TEST_DB_HOST = prodHost;
    expect(() => assertDevOnlyDatabase(prodUrl, CTX)).toThrow(/PRODUCTION database/);
  });

  it("refuses any other remote host, even one opted in with ALLOW_TEST_DB_HOST", () => {
    const other = "postgresql://u:p@ep-some-branch-123.aws.neon.tech/neondb";
    process.env.ALLOW_TEST_DB_HOST = "ep-some-branch-123.aws.neon.tech";
    expect(() => assertDevOnlyDatabase(other, CTX)).toThrow(/only runs against local/);
  });

  it("matches the dev branch as a prefix, not anywhere in the host", () => {
    expect(() => assertDevOnlyDatabase("postgresql://u:p@evil-ep-flat-rain-x.example.com/db", CTX)).toThrow();
  });

  it("fails closed on a missing or unparseable URL", () => {
    for (const url of ["", "   ", "not-a-url"]) {
      expect(() => assertDevOnlyDatabase(url, CTX)).toThrow(/REFUSING TO RUN/);
    }
  });
});

describe("assertDevelopmentEnv", () => {
  it("allows development and unset", () => {
    expect(() => assertDevelopmentEnv("development", CTX)).not.toThrow();
    expect(() => assertDevelopmentEnv(undefined, CTX)).not.toThrow();
  });

  it("refuses production and test", () => {
    expect(() => assertDevelopmentEnv("production", CTX)).toThrow(/NODE_ENV is "production"/);
    expect(() => assertDevelopmentEnv("test", CTX)).toThrow(/REFUSING/);
  });
});

describe("assertLocalApiUrl", () => {
  it("allows this Mac and the local network", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.20:3000", "http://10.0.0.4:3000"]) {
      expect(() => assertLocalApiUrl(url, CTX), url).not.toThrow();
    }
  });

  it("refuses the deployed server and any public host", () => {
    for (const url of ["https://campusride-server-aaum.onrender.com", "http://8.8.8.8:3000", "nonsense"]) {
      expect(() => assertLocalApiUrl(url, CTX), url).toThrow();
    }
  });
});
