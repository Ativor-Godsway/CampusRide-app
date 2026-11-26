/**
 * `npm run staging:db:rebuild --workspace apps/server -- --yes` — wipes the
 * STAGING database and builds it again from nothing (STAGING.md): every
 * table dropped, all of this checkout's migrations applied, the setup data
 * loaded from the saved snapshot, the test accounts created. For when a
 * branch's migrations left staging in a state another branch can't use.
 * Staging branch only (./env.ts); asks for --yes.
 */
import "./env"; // MUST stay first: loads .env.staging and refuses anything but the staging branch.
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { SERVER_ROOT } from "./env";

async function main(): Promise<void> {
  if (!process.argv.includes("--yes")) {
    throw new Error("This wipes everything on staging (test rides, fake riders). Run it again with --yes.");
  }
  const prisma = new PrismaClient({ log: ["error"], datasources: { db: { url: process.env.DIRECT_URL } } });
  try {
    console.log("\nWiping the staging database…");
    await prisma.$executeRawUnsafe("DROP SCHEMA public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
  } finally {
    await prisma.$disconnect();
  }
  const run = (script: string) =>
    execFileSync("npx", ["ts-node", "--transpile-only", "-r", "tsconfig-paths/register", `src/scripts/staging/${script}.ts`], {
      cwd: SERVER_ROOT,
      stdio: "inherit",
      env: process.env,
    });
  run("migrate");
  run("seedSetup");
  run("accounts");
  console.log("Staging rebuilt.\n");
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
