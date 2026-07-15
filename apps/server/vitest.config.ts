import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@rida/shared": path.resolve(__dirname, "../../packages/shared/src/index.ts"),
    },
  },
  test: {
    // Force NODE_ENV=test so config.ts loads `.env.test` (the isolated Neon
    // `test` branch), not the base `.env`. Vitest defaults to this, but pin it
    // explicitly so the dev/test/prod split can't silently regress.
    env: { NODE_ENV: "test" },
    // Neon's pooled connection has noticeable per-query latency; the ride
    // service tests issue many sequential queries inside transactions.
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ["./src/test/setup.ts"],
    // Run test files sequentially — multiple files hammering the same Neon
    // pooled connection concurrently causes intermittent P1001 "can't reach
    // database server" errors.
    fileParallelism: false,
  },
});
