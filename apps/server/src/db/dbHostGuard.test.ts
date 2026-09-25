/**
 * ~353 test-fixture accounts were written into the production database.
 *
 * The actual path: before 2026-07-15 there was no .env.test and no guard at
 * all, so `npm test` loaded the base .env — which pointed at production. The
 * fixture timestamps (2026-06-08, 2026-06-19) predate the guard by a month.
 *
 * The guard added afterwards was still a DENYLIST naming one host, which
 * fails open against any host it has not heard of. These tests pin the
 * inverted rule, and — more importantly — the connection-level gate below,
 * because `npm test` never runs the db:guard script and a check that lives
 * only in a setup file protects only the paths that load it.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  assertNotProdDatabase,
  assertDatabaseAllowedForEnv,
  dbHostFromUrl,
  KNOWN_PROD_DB_HOSTS,
} from "./dbHostGuard";

const CTX = "test";
const originalAllow = process.env.ALLOW_TEST_DB_HOST;
const originalProdOptIn = process.env.ALLOW_PRODUCTION_DB;

afterEach(() => {
  if (originalAllow === undefined) delete process.env.ALLOW_TEST_DB_HOST;
  else process.env.ALLOW_TEST_DB_HOST = originalAllow;
  if (originalProdOptIn === undefined) delete process.env.ALLOW_PRODUCTION_DB;
  else process.env.ALLOW_PRODUCTION_DB = originalProdOptIn;
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


/**
 * The connection-level gate. This is the one that actually closes the hole:
 * `npm test` is `vitest run` and never invokes the db:guard script, so a check
 * that lives only in a setup file protects only the paths that load it.
 */
describe("assertDatabaseAllowedForEnv", () => {
  describe("NODE_ENV=test", () => {
    it("allows local Postgres", () => {
      expect(() => assertDatabaseAllowedForEnv(local, "test", CTX)).not.toThrow();
    });

    it("REFUSES production — the exact path that polluted the live database", () => {
      // Before .env.test existed, `npm test` fell back to the base .env, which
      // pointed here. Nothing stopped it.
      expect(() => assertDatabaseAllowedForEnv(neonProd, "test", CTX)).toThrow(
        /known\s+PRODUCTION host/,
      );
    });

    it("REFUSES an unnamed remote host", () => {
      expect(() => assertDatabaseAllowedForEnv(neonTest, "test", CTX)).toThrow(/REFUSING TO RUN/);
    });

    it("cannot be unlocked by the production opt-in", () => {
      // A test must NEVER reach production, whatever is exported in the shell.
      process.env.ALLOW_PRODUCTION_DB = "1";
      expect(() => assertDatabaseAllowedForEnv(neonProd, "test", CTX)).toThrow(
        /known\s+PRODUCTION host/,
      );
    });
  });

  describe("NODE_ENV=development", () => {
    it("allows the dev Neon branch", () => {
      const dev = "postgresql://u:p@ep-flat-rain-apsyo6mp-pooler.c-7.us-east-1.aws.neon.tech/neondb";
      expect(() => assertDatabaseAllowedForEnv(dev, "development", CTX)).not.toThrow();
    });

    it("allows local Postgres", () => {
      expect(() => assertDatabaseAllowedForEnv(local, "development", CTX)).not.toThrow();
    });

    it("REFUSES a production host, so the dev server cannot boot against it", () => {
      expect(() => assertDatabaseAllowedForEnv(neonProd, "development", CTX)).toThrow(
        /REFUSING TO CONNECT/,
      );
    });

    it("allows production ONLY with the deliberate per-command opt-in", () => {
      // seedAdmin / cleanupTestAccounts are supposed to touch production.
      process.env.ALLOW_PRODUCTION_DB = "1";
      expect(() => assertDatabaseAllowedForEnv(neonProd, "development", CTX)).not.toThrow();
    });

    it("does not accept a truthy-looking value other than exactly \"1\"", () => {
      process.env.ALLOW_PRODUCTION_DB = "true";
      expect(() => assertDatabaseAllowedForEnv(neonProd, "development", CTX)).toThrow(
        /REFUSING TO CONNECT/,
      );
    });
  });

  describe("NODE_ENV=production", () => {
    it("allows production to connect to production", () => {
      expect(() => assertDatabaseAllowedForEnv(neonProd, "production", CTX)).not.toThrow();
    });
  });
});
