/**
 * `npm run staging:db:migrate --workspace apps/server [-- --schema <path>]` —
 * applies migrations to the staging database only (STAGING.md). With
 * --schema, a branch's own prisma/schema.prisma (and the migrations beside
 * it), as staging:deploy does; else this checkout's. Prints no URL.
 */
import "./env"; // MUST stay first: loads .env.staging and refuses anything but the staging branch.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { SERVER_ROOT } from "./env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const schema = arg("schema") ?? path.join(SERVER_ROOT, "prisma", "schema.prisma");
console.log(`\nApplying migrations to STAGING from ${path.relative(process.cwd(), schema) || schema}…`);
try {
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", schema], { cwd: SERVER_ROOT, stdio: "inherit", env: process.env });
  console.log("Staging database is up to date.\n");
} catch {
  console.error("\n✗ Migrating staging failed (see above).\n");
  process.exitCode = 1;
}
