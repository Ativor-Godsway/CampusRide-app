/**
 * What this server knows of each driver app's connection, in memory only:
 * whether a socket is connected, whether the app last said it was in front
 * or in the background (DRIVER_CLIENT_EVENTS.PRESENCE), and when anything
 * was last heard. The admin live map shows it.
 *
 * Whether a driver counts as online — and setting them offline after 10
 * minutes of silence — is services/zones/driverLiveness.ts, from
 * Driver.lastHeartbeatAt, which survives a restart. (Until 2026-11-24 this
 * file took drivers offline after 30 minutes, and only an app last in front
 * with no connection; launch showed drivers "online" for days without one.)
 */

interface Presence {
  /** The app has sent PRESENCE (an app from before it never does). */
  announced: boolean;
  state: "foreground" | "background";
  sockets: number;
  /** The last contact of any kind (epoch ms). */
  heardAt: number;
}

const presence = new Map<string, Presence>();

function entry(userId: string, now: number): Presence {
  let p = presence.get(userId);
  if (!p) {
    p = { announced: false, state: "foreground", sockets: 0, heardAt: now };
    presence.set(userId, p);
  }
  return p;
}

export function driverSocketConnected(userId: string, now: number = Date.now()): void {
  const p = entry(userId, now);
  p.sockets += 1;
  p.heardAt = now;
}

export function driverSocketDisconnected(userId: string, now: number = Date.now()): void {
  const p = presence.get(userId);
  if (!p) return;
  p.sockets = Math.max(0, p.sockets - 1);
  p.heardAt = now;
}

export function driverSaidPresence(userId: string, state: Presence["state"], now: number = Date.now()): void {
  const p = entry(userId, now);
  p.announced = true;
  p.state = state;
  p.heardAt = now;
}

/** Any other contact (a position). */
export function driverHeard(userId: string, now: number = Date.now()): void {
  const p = presence.get(userId);
  if (p) p.heardAt = now;
}

/** What the server knows of a driver's app now (admin live map), or null when nothing. */
export function driverPresenceOf(
  userId: string,
): { connected: boolean; state: Presence["state"] | null; heardAt: number } | null {
  const p = presence.get(userId);
  if (!p) return null;
  return { connected: p.sockets > 0, state: p.announced ? p.state : null, heardAt: p.heardAt };
}

/** Forgets drivers with no socket who haven't been heard from in a day (memory stays flat). */
export function sweepDriverPresence(now: number = Date.now()): void {
  for (const [userId, p] of presence) {
    if (p.sockets === 0 && now - p.heardAt > 24 * 60 * 60_000) presence.delete(userId);
  }
}

/** Tests only. */
export function resetDriverPresenceForTests(): void {
  presence.clear();
}
