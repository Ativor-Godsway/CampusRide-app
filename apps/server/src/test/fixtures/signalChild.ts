/**
 * Run as its own process by lib/shutdown.test.ts: a tiny server with the real
 * shutdown, listening for signals the way index.ts does.
 */
import Fastify from "fastify";
import { createShutdown, installSignalHandlers } from "../../lib/shutdown";

async function main() {
  const app = Fastify({ logger: true });
  app.get("/", async () => ({ ok: true }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const shutdown = createShutdown({
    app,
    io: null,
    log: app.log,
    timers: [],
    disconnectDatabase: async () => {},
  });
  installSignalHandlers({ shutdown, log: app.log });
  process.stdout.write("ready\n");
}

void main();
