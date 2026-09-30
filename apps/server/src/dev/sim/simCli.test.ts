/**
 * End-to-end refusal: the real sim commands, started against a production
 * URL with every override exported, must exit before touching a database.
 * This pins the ORDER that makes it true — simEnv runs its guard before
 * anything imports Prisma — which a unit test of the guard alone cannot.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const serverRoot = path.resolve(__dirname, "..", "..", "..");
const PROD = "postgresql://u:p@ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech/neondb";

function run(script: string, env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [require.resolve("ts-node/dist/bin.js"), "--transpile-only", "-r", "tsconfig-paths/register", script],
    {
      cwd: serverRoot,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    },
  );
}

describe.each([
  ["sim:riders", "src/dev/sim/riders.ts"],
  ["sim:cleanup", "src/dev/sim/cleanupCli.ts"],
  ["sim:approve-driver", "src/dev/sim/approveDriverCli.ts"],
])("%s", (_name, script) => {
  it("refuses a production DATABASE_URL even with ALLOW_PRODUCTION_DB=1 and ALLOW_TEST_DB_HOST set", () => {
    const res = run(script, {
      NODE_ENV: "development",
      DATABASE_URL: PROD,
      DIRECT_URL: PROD,
      ALLOW_PRODUCTION_DB: "1",
      ALLOW_TEST_DB_HOST: "ep-ancient-butterfly-app69akz-pooler.c-7.us-east-1.aws.neon.tech",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/REFUSING TO RUN .*PRODUCTION database/);
  });

  it("refuses NODE_ENV=production", () => {
    const res = run(script, { NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@localhost/rida" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/NODE_ENV is "production"/);
  });
});
