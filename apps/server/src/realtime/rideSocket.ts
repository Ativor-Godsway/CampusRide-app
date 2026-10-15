import type { Server as SocketIOServer, Socket } from "socket.io";
import type { PrismaClient, UserRole } from "@prisma/client";
import { ACTIVE_DRIVER_STATUSES, isActivePassengerStatus } from "../services/ride/stateMachine";
import {
  RIDE_CLIENT_EVENTS,
  DRIVER_CLIENT_EVENTS,
  DRIVER_EVENTS,
  RIDE_EVENTS,
  type PassengerStatus,
  type RideServerEvent,
  type RideServerEventPayloads,
  type RideBroadcastPayload,
  type DriverLocationUpdatePayload,
  type OfferClosedPayload,
} from "@rida/shared";
import { verifyAccessToken } from "../services/auth/tokens";
import { loadActiveAccount } from "../services/auth/accountStatus";
import { checkDriverArriving } from "../services/push/notify";
import { limiter } from "../rateLimit/limiter";
import { RULES } from "../rateLimit/rules";

let ioRef: SocketIOServer | null = null;

function roomForRide(rideId: string): string {
  return `ride:${rideId}`;
}

function roomForDriver(userId: string): string {
  return `driver:${userId}`;
}

function roomForRider(userId: string): string {
  return `rider:${userId}`;
}

/** Who a socket belongs to, settled once at the handshake. */
interface SocketUser {
  userId: string;
  role: UserRole;
}

/**
 * The one reason a refused handshake gives, whatever the cause (no token,
 * bad or expired token, deleted account), so a caller learns nothing about
 * which. The app answers it by refreshing its token and reconnecting.
 */
export const SOCKET_AUTH_ERROR = "unauthorized";

/**
 * Checks a handshake's access token and that its account is still open.
 * Null for anything else — including an OTP verification token, which is
 * signed with the same secret but is not an access token.
 */
export async function authenticateSocket(prisma: PrismaClient, token: unknown): Promise<SocketUser | null> {
  if (typeof token !== "string" || token.length === 0) return null;
  let userId: string;
  try {
    userId = verifyAccessToken(token).userId;
  } catch {
    return null;
  }
  const account = await loadActiveAccount(prisma, userId);
  return account ? { userId: account.userId, role: account.role } : null;
}

/** A ride id as clients send it (Prisma cuids); anything else is ignored unread. */
function isRideId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Wires up the real-time layer (Phase 5c + 6a):
 *
 * Handshake:
 * - A socket is admitted only with a valid ACCESS token of an open account
 *   (`authenticateSocket`, run as Socket.io middleware). Anything else is
 *   refused before "connection" with SOCKET_AUTH_ERROR. A socket stays
 *   admitted once in; deleting the account closes it (`disconnectUser`).
 *
 * Rider side (Phase 5c):
 * - `ride:subscribe` / `ride:unsubscribe` join/leave the `ride:{rideId}` room,
 *   after `authorizeRideAccess`. An optional acknowledgement callback gets
 *   `{ ok }` — false for a ride that isn't the caller's, the same as for one
 *   that doesn't exist.
 *
 * Driver side (Phase 6a):
 * - Every authenticated driver is automatically joined to `driver:{userId}` so
 *   the server can push `ride:broadcast` events to them.
 * - `driver:location` events from the ride's own driver are re-emitted as
 *   `ride:driver_location` to the ride's room (riders see live GPS). Anyone
 *   else's, and malformed ones, are dropped without a reply.
 *
 * Per-passenger side (Phase 6b-3):
 * - Every authenticated user (rider or driver) also joins a personal
 *   `rider:{userId}` room on connect, mirroring the driver-room pattern, so
 *   per-passenger driver actions (arrived/pickup/dropoff) can target exactly
 *   the one affected rider via `emitToRider` instead of broadcasting to the
 *   whole `ride:{rideId}` room where every passenger would see every other
 *   passenger's events.
 */
export function initRideSocket(io: SocketIOServer, prisma: PrismaClient): void {
  ioRef = io;

  io.use((socket, next) => {
    authenticateSocket(prisma, socket.handshake.auth?.token).then(
      (user) => {
        if (!user) return next(new Error(SOCKET_AUTH_ERROR));
        socket.data.user = user;
        next();
      },
      () => next(new Error(SOCKET_AUTH_ERROR)),
    );
  });

  io.on("connection", (socket: Socket) => {
    const { userId, role } = socket.data.user as SocketUser;

    // Every driver joins their personal room immediately on connect so they
    // receive ride:broadcast events pushed by broadcastRide.
    if (role === "DRIVER") {
      void socket.join(roomForDriver(userId));
    }

    // Every authenticated user joins a personal rider room so per-passenger
    // events can be targeted to exactly them.
    void socket.join(roomForRider(userId));

    socket.on(RIDE_CLIENT_EVENTS.SUBSCRIBE, (rideId: unknown, ack?: unknown) => {
      const reply = typeof ack === "function" ? (ack as (r: { ok: boolean }) => void) : () => {};
      if (!isRideId(rideId)) return reply({ ok: false });
      // Each check reads the database; past the per-account limit the
      // answer is simply no (the app re-subscribes on its next screen).
      limiter
        .consume([{ rule: RULES.socketSubscribe, subject: userId }])
        .then((allowed) => (allowed.ok ? loadActiveAccount(prisma, userId) : null))
        .then((account) => (account ? authorizeRideAccess(prisma, rideId, userId) : false))
        .then(
          (allowed) => {
            if (allowed) void socket.join(roomForRide(rideId));
            reply({ ok: allowed });
          },
          () => reply({ ok: false }),
        );
    });

    socket.on(RIDE_CLIENT_EVENTS.UNSUBSCRIBE, (rideId: unknown) => {
      if (!isRideId(rideId)) return;
      void socket.leave(roomForRide(rideId));
    });

    // Driver streams GPS during an active ride; server re-emits to the ride room.
    // The check is cached briefly per socket: positions arrive every few
    // seconds and the answer rarely changes.
    const driverRideChecks = new Map<string, { allowed: boolean; at: number }>();
    const checkDriverRide = async (rideId: string) => {
      const cached = driverRideChecks.get(rideId);
      if (cached && Date.now() - cached.at < DRIVER_RIDE_CHECK_TTL_MS) return cached.allowed;
      const allowed =
        (await loadActiveAccount(prisma, userId)) !== null && (await authorizeDriverRide(prisma, rideId, userId));
      driverRideChecks.set(rideId, { allowed, at: Date.now() });
      return allowed;
    };
    // At most one position per driver every RATE_LIMIT_DRIVER_LOCATION_SECONDS
    // (the app sends every 4 s); extras are dropped silently, never answered
    // with a disconnect, so a chatty phone just has fewer positions relayed.
    socket.on(DRIVER_CLIENT_EVENTS.LOCATION_UPDATE, (data: unknown) => {
      if (!isDriverLocationUpdate(data)) return;
      limiter
        .consume([{ rule: RULES.driverLocation, subject: userId }])
        .then((allowed) => (allowed.ok ? checkDriverRide(data.rideId) : false))
        .then(
        (allowed) => {
          if (!allowed) return;
          ioRef?.to(roomForRide(data.rideId)).emit(RIDE_EVENTS.DRIVER_LOCATION, {
            rideId: data.rideId,
            lat: data.lat,
            lng: data.lng,
            ts: Date.now(),
          });
          // "Almost at your pickup" for riders still waiting (throttled per ride).
          checkDriverArriving(prisma, data.rideId, userId, { latitude: data.lat, longitude: data.lng });
        },
        () => {},
      );
    });
  });
}

/** A position a phone could actually report: finite, and on the globe. */
export function isDriverLocationUpdate(v: unknown): v is DriverLocationUpdatePayload {
  if (typeof v !== "object" || v === null) return false;
  const { rideId, lat, lng } = v as Record<string, unknown>;
  return (
    isRideId(rideId) &&
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/**
 * Who may listen to a ride's room:
 *
 * - its driver, so a rider cancelling or the trip changing reaches the
 *   driver's trip screen in a second or two instead of at the next poll;
 * - a rider whose own seat on it is still live (WAITING, ARRIVED or
 *   PICKED_UP). A rider who has been dropped off or whose seat was cancelled
 *   no longer follows the car — that would be watching the rest of someone
 *   else's trip. (Their own news still reaches them in their personal room.)
 * - the requester of a ride from before every rider had a seat row.
 *
 * A requester whose request was merged into another car keeps a WAITING seat
 * on the closed request, so they still hear it close and follow the merge.
 */
export async function authorizeRideAccess(
  prisma: PrismaClient,
  rideId: string,
  userId: string,
): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: {
      riderId: true,
      driverId: true,
      passengers: { where: { riderId: userId }, select: { status: true } },
    },
  });
  if (!ride) return false;
  if (ride.driverId === userId) return true;
  if (ride.passengers.some((seat) => isActivePassengerStatus(seat.status as PassengerStatus))) return true;
  return ride.riderId === userId && ride.passengers.length === 0;
}

/** Short: after a trip ends its driver's positions stop being relayed within this. */
const DRIVER_RIDE_CHECK_TTL_MS = 10_000;

/**
 * Allows a location update only from the ride's driver while the trip is
 * active — MATCHED and ARRIVED as well as IN_PROGRESS. It used to be
 * IN_PROGRESS only, so riders never saw their driver on the way to the
 * pickup: positions sent before the first pickup were silently dropped.
 */
export async function authorizeDriverRide(
  prisma: PrismaClient,
  rideId: string,
  userId: string,
): Promise<boolean> {
  const ride = await prisma.ride.findUnique({
    where: { id: rideId },
    select: { driverId: true, status: true },
  });
  if (!ride) return false;
  return ride.driverId === userId && (ACTIVE_DRIVER_STATUSES as readonly string[]).includes(ride.status);
}

/** Closes every socket of an account — used when the account is deleted. */
export function disconnectUser(userId: string): void {
  ioRef?.in(roomForRider(userId)).disconnectSockets(true);
}

/**
 * A rider's sockets stop following a ride they are no longer in (dropped
 * off, or their seat cancelled), so they don't keep receiving the driver's
 * position for the rest of other riders' trip.
 */
export function removeRiderFromRide(riderId: string, rideId: string): void {
  ioRef?.in(roomForRider(riderId)).socketsLeave(roomForRide(rideId));
}

/** Emits a contract event to everyone subscribed to a ride's room. No-op if the socket server isn't initialized (e.g. tests). */
export function emitRideEvent<E extends RideServerEvent>(
  rideId: string,
  event: E,
  payload: RideServerEventPayloads[E],
): void {
  ioRef?.to(roomForRide(rideId)).emit(event, payload);
}

/**
 * Emits a contract event to exactly one rider's personal room (Phase 6b-3),
 * not the whole ride room — used for per-passenger driver actions
 * (arrived/pickup/dropoff) so other passengers on the same SHARED ride never
 * see an event meant for someone else. No-op if the socket server isn't
 * initialized (e.g. tests).
 */
export function emitToRider<E extends RideServerEvent>(
  riderId: string,
  event: E,
  payload: RideServerEventPayloads[E],
): void {
  ioRef?.to(roomForRider(riderId)).emit(event, payload);
}

/** Emits a ride:broadcast event to all specified driver user rooms. */
/** A request offered to these drivers is gone (taken, cancelled, expired): their apps drop it at once. */
export function emitOfferClosed(driverUserIds: string[], payload: OfferClosedPayload): void {
  if (!ioRef || driverUserIds.length === 0) return;
  ioRef.to(driverUserIds.map(roomForDriver)).emit(DRIVER_EVENTS.OFFER_CLOSED, payload);
}

export function emitDriverBroadcast(
  driverUserIds: string[],
  payload: RideBroadcastPayload,
): void {
  if (!ioRef || driverUserIds.length === 0) return;
  const rooms = driverUserIds.map(roomForDriver);
  ioRef.to(rooms).emit(DRIVER_EVENTS.RIDE_BROADCAST, payload);
}
