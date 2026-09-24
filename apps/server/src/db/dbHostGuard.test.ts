/**
 * This guard failed open once, and ~353 test-fixture accounts were written
 * into the production database as a result. It was a denylist naming a single
 * Neon host; a .env.test pointing at a different Neon host passed straight
 * through. These tests pin the inverted rule: local is fine, everything else
 * must be named deliberately, production is never allowed.
 */
import { describe, it, expect, afterEach } from "vitest";
import { assertNotProdDatabase, dbHostFromUrl, KNOWN_PROD_DB_HOSTS } from "./dbHostGuard";

const CTX = "test";
const originalAllow = process.env.ALLOW_TEST_DB_HOST;

afterEach(() => {
  if (originalAllow === undefined) delete process.env.ALLOW_TEST_DB_HOST;
  else process.env.ALLOW_TEST_DB_HOST = originalAllow;
});

const local = "postgresql://user:pw@localhost:5432/rida_test";
const neonTest = "postgresql://user:pw@ep-some-branch-123-pooler.c-7.us-east-1.aws.neon.tech/neondb";
const neonProd = "postgresql://user:pw@ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech/neondb";
const neonOther = "postgresql://user:pw@ep-blue-union-apn52wdn-pooler.c-7.us-east-1.aws.neon.tech/neondb";

describe("local databases", () => {
  it("allows localhost and friends", () => {
    for (const host of ["localhost", "127.0.0.1", "host.docker.internal"]) {
      expect(() =>
        assertNotProdDatabase(`postgresql://u:p@${host}:5432/rida_test`, CTX),
      ).not.toThrow();
    }
  });
});

describe("remote databases", () => {
  it("REFUSES an unnamed remote host — the failure that let fixtures into production", () => {
    // Under the old denylist this passed, because the host was simply not the
    // one hardcoded name it knew about.
    expect(() => assertNotProdDatabase(neonTest, CTX)).toThrow(/REFUSING TO RUN against remote host/);
  });

  it("allows a remote host only when it is named exactly in ALLOW_TEST_DB_HOST", () => {
    process.env.ALLOW_TEST_DB_HOST = "ep-some-branch-123-pooler.c-7.us-east-1.aws.neon.tech";
    expect(() => assertNotProdDatabase(neonTest, CTX)).not.toThrow();
  });

  it("does not accept a partial or near-miss opt-in", () => {
    process.env.ALLOW_TEST_DB_HOST = "ep-some-branch";
    expect(() => assertNotProdDatabase(neonTest, CTX)).toThrow(/REFUSING TO RUN/);
  });
});

describe("production hosts", () => {
  it("refuses every known production host", () => {
    for (const prod of KNOWN_PROD_DB_HOSTS) {
      const url = `postgresql://u:p@${prod}-xyz-pooler.c-7.us-east-1.aws.neon.tech/neondb`;
      expect(() => assertNotProdDatabase(url, CTX)).toThrow(/known\s+PRODUCTION host/);
    }
  });

  it("refuses production EVEN IF someone opts it in", () => {
    // The opt-in is for disposable branches. It must not be usable as an
    // override for the one thing the guard exists to protect.
    process.env.ALLOW_TEST_DB_HOST = "ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech";
    expect(() => assertNotProdDatabase(neonProd, CTX)).toThrow(/known\s+PRODUCTION host/);
  });

  it("refuses the host that .env.test pointed at during the incident", () => {
    expect(() => assertNotProdDatabase(neonOther, CTX)).toThrow(/known\s+PRODUCTION host/);
  });
});

describe("fail closed", () => {
  it("refuses a missing or unparseable URL rather than assuming it is safe", () => {
    for (const url of ["", "   ", "not-a-url", "postgres-without-scheme/db"]) {
      expect(() => assertNotProdDatabase(url, CTX)).toThrow(/REFUSING TO RUN/);
    }
  });

  it("names the calling context so the failure points at the culprit", () => {
    expect(() => assertNotProdDatabase(neonProd, "test setup")).toThrow(/\[test setup\]/);
  });
});

describe("dbHostFromUrl", () => {
  it("extracts the host without exposing credentials", () => {
    expect(dbHostFromUrl(local)).toBe("localhost");
    expect(dbHostFromUrl(neonProd)).toBe("ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech");
  });

  it("returns null for junk", () => {
    expect(dbHostFromUrl("")).toBeNull();
    expect(dbHostFromUrl("nonsense")).toBeNull();
  });
});
