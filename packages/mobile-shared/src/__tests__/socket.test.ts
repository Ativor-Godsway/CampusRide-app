import * as SecureStore from "expo-secure-store";
import { RIDE_CLIENT_EVENTS } from "@rida/shared";
import { setSessionRejectedHandler } from "../auth/apiClient";
import { getAccessToken, setAccessToken } from "../auth/tokenStore";
import { setStoredRefreshToken } from "../auth/storage";
import { getRideSocket, resetRideSocket, subscribeToRide } from "../realtime/socket";
import { installFakeServer, type FakeServer } from "./fakeServer";
import { freshLaunch } from "./routes";

/**
 * The live connection (Socket.io) during a trip: a server restart, a lost
 * connection, or an expired token at reconnect never signs anyone out; only
 * a session the server truly refuses does.
 */

type Handler = (...args: unknown[]) => void;
interface FakeSocket {
  active: boolean;
  connected: boolean;
  handlers: Map<string, Handler[]>;
  emitted: unknown[][];
  connect: jest.Mock;
  disconnect: jest.Mock;
  fire(event: string, ...args: unknown[]): void;
}

const sockets: FakeSocket[] = [];

jest.mock("socket.io-client", () => ({
  io: jest.fn(() => {
    const socket: FakeSocket = {
      active: true,
      connected: false,
      handlers: new Map(),
      emitted: [],
      connect: jest.fn(() => {
        socket.active = true;
      }),
      disconnect: jest.fn(),
      fire(event, ...args) {
        for (const h of socket.handlers.get(event) ?? []) h(...args);
      },
    };
    Object.assign(socket, {
      // Read by the development-build connection log.
      io: { engine: { transport: { name: "websocket" } } },
      on(event: string, handler: Handler) {
        socket.handlers.set(event, [...(socket.handlers.get(event) ?? []), handler]);
        return socket;
      },
      emit(...args: unknown[]) {
        socket.emitted.push(args);
        return socket;
      },
    });
    sockets.push(socket);
    return socket;
  }),
}));

let server: FakeServer;
let signedOut: jest.Mock;

beforeEach(async () => {
  jest.useFakeTimers();
  (SecureStore as unknown as { __store: Map<string, string> }).__store.clear();
  await freshLaunch();
  resetRideSocket();
  sockets.length = 0;
  server = installFakeServer("DRIVER");
  const tokens = server.issue();
  setAccessToken(tokens.accessToken);
  await setStoredRefreshToken(tokens.refreshToken);
  signedOut = jest.fn();
  setSessionRejectedHandler(signedOut);
});

/** The server refuses the handshake (Socket.io then stops retrying by itself). */
function refuseHandshake(socket: FakeSocket) {
  socket.active = false;
  socket.fire("connect_error", new Error("Unauthorized"));
}

async function runTimers(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

it("a refused handshake (expired token): refreshes, reconnects, stays signed in", async () => {
  const socket = getRideSocket() as unknown as FakeSocket;
  const before = getAccessToken();
  refuseHandshake(socket);
  await runTimers(2_500);
  expect(server.calls).toEqual(["POST /auth/refresh"]);
  expect(getAccessToken()).not.toBe(before);
  expect(socket.connect).toHaveBeenCalled();
  expect(signedOut).not.toHaveBeenCalled();
});

it("a server restart (connection dropped, then back): rejoins the trip, no refresh, no sign-out", async () => {
  const socket = getRideSocket() as unknown as FakeSocket;
  subscribeToRide("ride-1");
  socket.fire("disconnect", "transport close");
  socket.fire("connect");
  expect(socket.emitted.filter(([event]) => event === RIDE_CLIENT_EVENTS.SUBSCRIBE)).toEqual([
    [RIDE_CLIENT_EVENTS.SUBSCRIBE, "ride-1"],
    [RIDE_CLIENT_EVENTS.SUBSCRIBE, "ride-1"],
  ]);
  await runTimers(60_000);
  expect(server.calls).toEqual([]);
  expect(signedOut).not.toHaveBeenCalled();
});

it("network trouble while connecting (Socket.io keeps retrying): not treated as a refusal", async () => {
  const socket = getRideSocket() as unknown as FakeSocket;
  socket.fire("connect_error", new Error("xhr poll error")); // still active
  await runTimers(60_000);
  expect(server.calls).toEqual([]);
  expect(signedOut).not.toHaveBeenCalled();
});

it("refused, and the refresh can't reach the server: tries again later, stays signed in", async () => {
  const socket = getRideSocket() as unknown as FakeSocket;
  server.outage = "network";
  refuseHandshake(socket);
  await runTimers(2_500);
  await runTimers(4_500);
  expect(server.calls.filter((c) => c === "POST /auth/refresh").length).toBeGreaterThanOrEqual(2);
  expect(signedOut).not.toHaveBeenCalled();

  server.outage = null;
  await runTimers(10_000);
  expect(socket.connect).toHaveBeenCalled();
  expect(signedOut).not.toHaveBeenCalled();
});

it("refused, and the session is truly revoked: signs out", async () => {
  const socket = getRideSocket() as unknown as FakeSocket;
  server.revokeAll();
  refuseHandshake(socket);
  await runTimers(2_500);
  expect(signedOut).toHaveBeenCalledTimes(1);
  expect(getAccessToken()).toBeNull();
});
