import { io, type Socket } from "socket.io-client";
import { RIDE_CLIENT_EVENTS } from "@rida/shared";
import { getServerUrl } from "../config/serverUrl";
import { getAccessToken } from "../auth/tokenStore";

let socket: Socket | null = null;

/**
 * Lazily creates a single shared Socket.io connection, authenticated with
 * the current access token (same JWT used for HTTP `Authorization: Bearer`).
 * Reused across ride subscriptions so the app holds at most one socket.
 */
export function getRideSocket(): Socket {
  if (!socket) {
    socket = io(getServerUrl(), {
      auth: { token: getAccessToken() },
      transports: ["websocket"],
      autoConnect: true,
    });
  }
  return socket;
}

export function subscribeToRide(rideId: string): void {
  getRideSocket().emit(RIDE_CLIENT_EVENTS.SUBSCRIBE, rideId);
}

export function unsubscribeFromRide(rideId: string): void {
  getRideSocket().emit(RIDE_CLIENT_EVENTS.UNSUBSCRIBE, rideId);
}
