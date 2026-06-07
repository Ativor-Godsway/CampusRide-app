import { beforeAll } from "vitest";
import { prisma } from "../db/prisma";

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
