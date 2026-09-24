import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The admin app is a plain static SPA: it talks to the same Fastify API the
 * rider/driver apps do, over the same public endpoints, so there is no server
 * side of its own to build or deploy.
 *
 * VITE_API_URL points it at that API. In development it defaults to
 * http://localhost:3000 (see src/api.ts); in production it MUST be set to the
 * deployed server's origin at BUILD time — Vite inlines it into the bundle.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist" },
});
