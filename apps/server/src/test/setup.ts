// Import config FIRST so the env-specific file (.env.test) is loaded before
// db/prisma reads DATABASE_URL — otherwise the client could bind to whatever
// the base .env points at.
import "../config";
import { beforeAll } from "vitest";
import { prisma } from "../db/prisma";
import { config } from "../config";
import { assertDatabaseAllowedForEnv } from "../db/dbHostGuard";
import { setServiceHoursGateForTests } from "../services/service/serviceHours";
import { setMovingFirstForTests } from "../services/ride/searchWindow";

/**
 * SAFETY GATE. The suite creates and deletes rows, so it must never run
 * against production — or against any remote database nobody named.
 *
 * NOTE ON ORDER: this statement runs AFTER the imports above, because ES
 * module imports are hoisted. That is fine, and deliberately not the only
 * protection: the real gate is inside db/prisma.ts, which runs the same check
 * as it constructs the client. So the connection is refused at its source even
 * if this file were removed, reordered, or dropped from vitest's setupFiles.
 * `npm test` is `vitest run` and never invokes the `db:guard` script, so a
 * check that lives only here protects only the paths that remember to load it.
 */
assertDatabaseAllowedForEnv(config.databaseUrl, config.nodeEnv, "test setup");

/**
 * Service hours would refuse bookings by the time of day and when no driver
 * is online, so every test that books a ride would depend on the clock. The
 * gate is off for the suite; serviceHours.test.ts turns it on for its own tests.
 */
setServiceHoursGateForTests(false);

/**
 * Fill moving cars first would hold Shared requests for cars already on a
 * trip, changing what every dispatch test sees. Off for the suite;
 * movingFirst.test.ts turns it on for its own tests.
 */
setMovingFirstForTests({ movingFirstEnabled: false });

/**
 * Each test file gets a fresh Prisma Client / DB connection. Neon's pooled
 * endpoint occasionally needs a moment to wake up, and the very first query
 * of a file fails with P1001 ("can't reach database server") before
 * subsequent queries succeed. Retry a trivial query before the suite runs
 * so flaky cold-starts don't fail real tests.
 */
beforeAll(async () => {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}, 30000);
