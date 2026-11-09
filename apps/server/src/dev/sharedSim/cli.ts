/**
 * `npm run simulate:shared` — plays out whole shared-ride trips against a
 * LOCAL server (every route + Socket.io, started here on 127.0.0.1, on the
 * local dev database) and prints a readable timeline:
 *
 *   10:00:05  Rider 3 requests a ride (Shared)
 *   10:00:05  Driver A sees Rider 3's request — pop-up and list
 *   10:00:17  Driver A's car is full …
 *
 * The scenarios are the integration test's (scenarios.ts). Pick some by
 * letter: `npm run simulate:shared -- b f`; `-- --test-db` runs on the local
 * test database (rida_test) instead of the local dev one. The accounts and
 * rides it makes are deleted after each scenario. Refuses to run unless the
 * database is a local Postgres (simGuard.ts): never production.
 */
import "./simGuard";
import { prisma } from "../../db/prisma";
import { SCENARIOS } from "./scenarios";
import { World } from "./world";

async function main(): Promise<void> {
  // The server's own JSON log lines (lib/logger) aren't the timeline: kept
  // for warnings and errors only.
  const print = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith('{"level":"info"')) return;
    print(...args);
  };

  const wanted = process.argv
    .slice(2)
    .filter((a) => !a.startsWith("--"))
    .map((a) => a.toLowerCase());
  const scenarios = wanted.length ? SCENARIOS.filter((s) => wanted.includes(s.key)) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`No scenario called ${wanted.join(", ")}. Scenarios: ${SCENARIOS.map((s) => s.key).join(" ")}`);
    process.exitCode = 1;
    return;
  }

  const world = new World(prisma, (line) => console.log(line));
  await world.start();
  const results: Array<{ key: string; title: string; error?: string }> = [];
  try {
    for (const scenario of scenarios) {
      world.heading(`── ${scenario.key}) ${scenario.title}`);
      try {
        await scenario.run(world);
        results.push({ key: scenario.key, title: scenario.title });
        console.log("   ✓ as expected");
      } catch (err) {
        results.push({ key: scenario.key, title: scenario.title, error: (err as Error).message });
        console.log(`   ✗ ${(err as Error).message}`);
      } finally {
        await world.cleanup();
      }
    }
  } finally {
    await world.stop();
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => r.error);
  console.log("");
  console.log(`${results.length - failed.length} of ${results.length} scenarios as expected`);
  for (const f of failed) console.log(`  ✗ ${f.key}) ${f.title}: ${f.error}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
