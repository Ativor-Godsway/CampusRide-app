import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { createShutdown, installSignalHandlers } from "./shutdown";

let app: FastifyInstance;
let io: Server | null = null;
const clients: ClientSocket[] = [];
let release = () => {};

afterEach(async () => {
  release();
  while (clients.length) clients.pop()!.close();
  io?.close();
  io = null;
  await app?.close();
});

/** A server with one slow route, listening on a free port. */
async function start() {
  app = Fastify({ return503OnClosing: true });
  const gate = new Promise<void>((resolve) => (release = resolve));
  app.get("/slow", async () => {
    await gate;
    return { finished: true };
  });
  app.get("/fast", async () => ({ ok: true }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { url };
}

function deps(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const exit = vi.fn();
  const disconnectDatabase = vi.fn(async () => {});
  const log = { info: vi.fn(), error: vi.fn() } as never;
  return { exit, disconnectDatabase, log, ...overrides };
}

describe("graceful shutdown", () => {
  it("lets in-flight requests finish, refuses new ones, then closes the database and exits 0", async () => {
    const { url } = await start();
    const d = deps();
    const timer = setInterval(() => {}, 60_000);
    const cleared = vi.spyOn(globalThis, "clearInterval");
    const shutdown = createShutdown({ app, io: null, timers: [timer], ...d });

    const inFlight = fetch(`${url}/slow`);
    await new Promise((r) => setTimeout(r, 50)); // the request has arrived
    const stopping = shutdown("SIGTERM");

    // A new connection is refused (Render sends it to the new server); one
    // already open gets 503.
    const late = await fetch(`${url}/fast`).then(
      (r) => r.status,
      () => "refused",
    );
    expect([503, "refused"]).toContain(late);
    expect(d.exit).not.toHaveBeenCalled();
    expect(d.disconnectDatabase).not.toHaveBeenCalled();

    release();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ finished: true });

    await stopping;
    expect(d.disconnectDatabase).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledWith(0);
    expect(cleared).toHaveBeenCalledWith(timer);
    cleared.mockRestore();
  });

  it("closes open sockets so the apps reconnect to the new server", async () => {
    const { url } = await start();
    io = new Server(app.server);
    const client = connect(url, { transports: ["websocket"], reconnection: false, forceNew: true });
    clients.push(client);
    await new Promise<void>((resolve) => client.once("connect", () => resolve()));
    const disconnected = new Promise<string>((resolve) =>
      client.once("disconnect", (reason) => resolve(reason)),
    );

    const d = deps();
    await createShutdown({ app, io, timers: [], ...d })("SIGTERM");
    expect(await disconnected).toBeTruthy();
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("runs once, however many signals arrive", async () => {
    await start();
    const d = deps();
    const shutdown = createShutdown({ app, io: null, timers: [], ...d });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(d.disconnectDatabase).toHaveBeenCalledOnce();
    expect(d.exit).toHaveBeenCalledOnce();
  });

  it("exits with the given code after a crash", async () => {
    await start();
    const d = deps();
    await createShutdown({ app, io: null, timers: [], ...d })("uncaughtException", 1);
    expect(d.exit).toHaveBeenCalledWith(1);
  });

  it("gives up and exits 1 if something hangs", async () => {
    await start();
    const d = deps({ disconnectDatabase: () => new Promise<void>(() => {}) });
    void createShutdown({ app, io: null, timers: [], timeoutMs: 100, ...d })("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});

describe("signals", () => {
  function setup() {
    let now = 0;
    const target = new EventEmitter();
    const shutdown = vi.fn(async () => {});
    const exit = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn() };
    installSignalHandlers({ shutdown, log, exit, now: () => now, target });
    return { target, shutdown, exit, advance: (ms: number) => (now += ms) };
  }

  it("starts the shutdown on SIGTERM and ignores repeats", () => {
    const { target, shutdown, exit, advance } = setup();
    target.emit("SIGTERM");
    target.emit("SIGTERM");
    advance(5000);
    target.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    expect(exit).not.toHaveBeenCalled();
  });

  it("ignores a duplicate Ctrl-C, but quits on a deliberate second one", () => {
    const { target, shutdown, exit, advance } = setup();
    target.emit("SIGINT");
    target.emit("SIGINT"); // npm's forwarded copy, microseconds later
    expect(exit).not.toHaveBeenCalled();
    advance(1500);
    target.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(130);
  });

  /**
   * Starts test/fixtures/signalChild.ts and sends SIGTERM as a deploy can:
   * once to the server, and again moments later (npm forwarding its copy).
   */
  function doubleSigterm() {
    const child = spawn(
      process.execPath,
      [
        "-r",
        "ts-node/register/transpile-only",
        path.join(__dirname, "../test/fixtures/signalChild.ts"),
      ],
      { cwd: path.join(__dirname, "../.."), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    return new Promise<{ code: number | null; signal: string | null; out: string }>((resolve) => {
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("ready\n") && !out.includes("#sent")) {
          out += "#sent";
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGTERM"), 5);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("exit", (code, signal) => resolve({ code, signal, out }));
    });
  }

  it("a server finishes its shutdown even when SIGTERM arrives twice", async () => {
    const { code, out } = await doubleSigterm();
    expect(out).toContain('"event":"shutdown"');
    expect(out).toContain('"event":"shutdown_complete"');
    expect(code).toBe(0);
  }, 30_000);
});
