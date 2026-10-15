/** Stage 4: a Socket.io message over the size limit closes that connection instead of being read. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect, type Socket as ClientSocket } from "socket.io-client";
import { SOCKET_MAX_PAYLOAD_BYTES } from "../http/serverOptions";

let httpServer: HttpServer;
let io: Server;
let url: string;
const open: ClientSocket[] = [];

beforeAll(async () => {
  httpServer = createServer();
  // The same option index.ts gives the real server.
  io = new Server(httpServer, { maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES });
  io.on("connection", (socket) => {
    socket.on("echo", (message: string, ack: (length: number) => void) => ack(message.length));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  while (open.length) open.pop()!.close();
  await new Promise<void>((resolve) => io.close(() => resolve()));
});

async function client(transport: "websocket" | "polling"): Promise<ClientSocket> {
  const socket = connect(url, { transports: [transport], reconnection: false, forceNew: true });
  open.push(socket);
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  return socket;
}

describe.each(["websocket", "polling"] as const)("Socket.io message size (%s)", (transport) => {
  it("reads an ordinary message", async () => {
    const socket = await client(transport);
    await expect(socket.timeout(2000).emitWithAck("echo", "x".repeat(500))).resolves.toBe(500);
  });

  it("drops the connection on a message over the limit", async () => {
    const socket = await client(transport);
    const dropped = new Promise<string>((resolve) =>
      socket.once("disconnect", (reason) => resolve(reason)),
    );
    const answer = socket
      .timeout(2000)
      .emitWithAck("echo", "x".repeat(SOCKET_MAX_PAYLOAD_BYTES + 1));
    await expect(answer).rejects.toThrow();
    expect(await dropped).toBeTruthy();
  });
});
