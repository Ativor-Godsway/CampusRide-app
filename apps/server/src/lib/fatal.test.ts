import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

/** Runs test/fixtures/fatalChild.ts in a separate process (crashing this one would take vitest with it). */
function crash(mode: "rejection" | "exception") {
  const result = spawnSync(
    process.execPath,
    [
      "-r",
      "ts-node/register/transpile-only",
      path.join(__dirname, "../test/fixtures/fatalChild.ts"),
      mode,
    ],
    { cwd: path.join(__dirname, "../.."), encoding: "utf8", timeout: 30_000 },
  );
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("an error nothing caught", () => {
  it.each([
    ["rejection", "unhandledRejection", "lost the ride"],
    ["exception", "uncaughtException", "crashed on"],
  ] as const)(
    "an unhandled %s is logged, scrubbed, and ends the process with code 1",
    (mode, kind, message) => {
      const { code, out } = crash(mode);
      expect(code).toBe(1);
      expect(out).toContain(kind);
      expect(out).toContain(message);
      expect(out).toContain("+233*****146");
      expect(out).not.toContain("548617146");
      expect(out).not.toContain("still running");
    },
  );
});
