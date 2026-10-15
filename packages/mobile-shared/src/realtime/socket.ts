import { io, type Socket } from "socket.io-client";
import { RIDE_CLIENT_EVENTS } from "@rida/shared";
import { getServerUrl } from "../config/serverUrl";
import { getAccessToken } from "../auth/tokenStore";
import { refreshSessionOrSignOut } from "../auth/apiClient";

let socket: Socket | null = null;

/**
 * After the server refuses the handshake (an expired access token, usually),
 * wait this long, refresh the token and connect again — doubling up to the
 * cap while the refresh keeps failing on the network.
 */
const AUTH_RETRY_BASE_MS = 2_000;
const AUTH_RETRY_MAX_MS = 60_000;
let authRetry: ReturnType<typeof setTimeout> | null = null;
let authRetryAttempt = 0;

/**
 * React Native defines the global `__DEV__` (true in Metro dev builds, false
 * in release bundles). Guarded with a typeof check so this module is still
 * safe to import from a plain Node context, such as a unit test.
 */
function isDev(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

/**
 * Lazily creates a single shared Socket.io connection, authenticated with
 * the current access token (same JWT used for HTTP `Authorization: Bearer`).
 * Reused across ride subscriptions so the app holds at most one socket.
 *
 * The token is read on EVERY connection attempt, not captured once: the API
 * client refreshes it as it expires, and a token captured at start-up made
 * every reconnect after 30 minutes fail. The server refuses an expired or
 * revoked token at the handshake; the app then refreshes and tries again.
 */
export function getRideSocket(): Socket {
  if (!socket) {
    const created = io(getServerUrl(), {
      auth: (cb) => cb({ token: getAccessToken() }),
      // Allow polling fallback — Render's proxy may not complete the WS upgrade
      // on the first attempt. Socket.io will try WebSocket first then fall back.
      transports: ["websocket", "polling"],
      autoConnect: true,
    });
    created.on("connect", () => {
      authRetryAttempt = 0;
    });
    created.on("connect_error", () => {
      // `active` stays true for network trouble (Socket.io retries by
      // itself) and turns false only when the SERVER refused the handshake.
      if (!created.active) scheduleAuthRetry(created);
    });
    socket = created;

    // Connection lifecycle logging is dev-only: in a release build these
    // lines run on every reconnect and put socket ids / server error strings
    // into the device log, where any other app with log access can read them.
    /* eslint-disable no-console -- Dev-only diagnostics, already gated by
       isDev() above so they are stripped from release bundles. React Native
       has no logger to route these through, and Metro's console IS the
       intended destination while debugging a connection. */
    if (isDev()) {
      created.on("connect", () => {
        console.log(
          "[Socket.io] connected",
          created.id,
          "transport:",
          (created as Socket & { io: { engine: { transport: { name: string } } } }).io.engine.transport.name,
        );
      });
      created.on("connect_error", (err: Error) => {
        console.warn("[Socket.io] connect_error:", err.message);
      });
      created.on("disconnect", (reason: string) => {
        console.log("[Socket.io] disconnected:", reason);
      });
    }
    /* eslint-enable no-console */
  }
  return socket;
}

function scheduleAuthRetry(target: Socket): void {
  if (authRetry) return;
  const delay = Math.min(AUTH_RETRY_MAX_MS, AUTH_RETRY_BASE_MS * 2 ** authRetryAttempt);
  authRetryAttempt += 1;
  authRetry = setTimeout(() => {
    authRetry = null;
    if (socket !== target) return; // signed out (or replaced) meanwhile
    refreshSessionOrSignOut().then(
      () => {
        if (socket === target && !target.connected) target.connect();
      },
      // A refused session signs the user out, which resets the socket and
      // ends this. Anything else (no network): try again later.
      () => {
        if (socket === target) scheduleAuthRetry(target);
      },
    );
  }, delay);
}

/**
 * Closes the socket and forgets it. Called whenever the signed-in person
 * changes or goes (sign-out, account deletion, refused session, a new
 * sign-in), so a phone handed to someone else never keeps the previous
 * person's connection, rooms or events.
 */
export function resetRideSocket(): void {
  if (authRetry) clearTimeout(authRetry);
  authRetry = null;
  authRetryAttempt = 0;
  socket?.disconnect();
  socket = null;
}

export function subscribeToRide(rideId: string): void {
  getRideSocket().emit(RIDE_CLIENT_EVENTS.SUBSCRIBE, rideId);
}

export function unsubscribeFromRide(rideId: string): void {
  getRideSocket().emit(RIDE_CLIENT_EVENTS.UNSUBSCRIBE, rideId);
}
