import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Coverage is INFORMATIONAL for now — no thresholds, because we have no
     * agreed baseline yet. CI prints the summary on every run so the number
     * stays visible; add `thresholds` here once a baseline is picked.
     *
     * packages/shared is pure domain logic with no I/O, so it should
     * eventually carry the highest bar of any workspace.
     */
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/index.ts", "src/types/**"],
    },
  },
});
