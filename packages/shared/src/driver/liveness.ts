/**
 * When an online driver counts as really online (2026-11-24). At launch 83%
 * of ride offers went to driver apps that had sent nothing for over 10
 * minutes, and four drivers left "online" from before were offered every
 * request without being there once.
 *
 * Now a driver counts as online only if their app was heard from in the last
 * DRIVER_STALE_AFTER_MS: a position, the app saying it's in front or in the
 * background, or its live connection's heartbeat (socket.io answers the
 * server's ping about every 25 s while the app runs, moving or not). A
 * driver who isn't gets no pop-ups and no listed requests, doesn't count as
 * "a driver online" for booking, and isn't shown online in admin. After the
 * same silence the server sets them offline (a trip under way is left
 * alone), and their app says why the next time it opens.
 */
export const DRIVER_STALE_AFTER_MS = 10 * 60_000;

/** Whether a driver last heard from at `heardAt` is still live at `now`. */
export function isDriverLive(heardAt: Date | number | null | undefined, now: number = Date.now()): boolean {
  if (heardAt === null || heardAt === undefined) return false;
  const at = typeof heardAt === "number" ? heardAt : heardAt.getTime();
  return now - at <= DRIVER_STALE_AFTER_MS;
}

/** What the driver app says after the server set the driver offline for silence. */
export const DRIVER_AUTO_OFFLINE_TITLE = "You're offline";
export const DRIVER_AUTO_OFFLINE_MESSAGE =
  "You were set offline because your app lost connection. Go online again to get requests.";
