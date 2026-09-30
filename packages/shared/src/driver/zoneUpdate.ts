/**
 * Keeping an online driver's zone current (Driver.currentZoneId) as they
 * move. Dispatch only offers a driver requests near their zone, so a zone set
 * once at "go online" goes stale the moment they drive off.
 *
 * Pure throttle decision, so the app's location watcher stays a thin shell:
 * a changed zone is sent at most once every ZONE_UPDATE_MIN_INTERVAL_MS, and
 * a change inside that window waits for the window to close (trailing edge),
 * so the LAST zone always lands.
 */

export const ZONE_UPDATE_MIN_INTERVAL_MS = 30_000;

export interface ZoneUpdateState {
  /** The zone the server last accepted, or null before the first send. */
  lastSentZoneId: string | null;
  /**
   * When that zone update was sent (ms). Null means "not throttled yet":
   * going online sends a zone with the availability call, and the first
   * fresh GPS fix after it may correct that zone straight away.
   */
  lastSentAt: number | null;
}

export type ZoneUpdatePlan =
  | { kind: "none" }
  | { kind: "send" }
  | { kind: "wait"; delayMs: number };

export function planZoneUpdate(
  state: ZoneUpdateState,
  zoneId: string | null,
  now: number,
  minIntervalMs: number = ZONE_UPDATE_MIN_INTERVAL_MS,
): ZoneUpdatePlan {
  if (zoneId === null || zoneId === state.lastSentZoneId) return { kind: "none" };
  if (state.lastSentAt === null) return { kind: "send" };
  const elapsed = now - state.lastSentAt;
  if (elapsed >= minIntervalMs) return { kind: "send" };
  return { kind: "wait", delayMs: minIntervalMs - elapsed };
}

/**
 * True for a failure worth retrying rather than reporting: no response at all
 * (timeout, offline, DNS, a server still waking up) or a gateway error while
 * the host restarts. A 4xx is a real answer ("not approved") and is never
 * retried.
 */
export function isTransientRequestFailure(failure: { status?: number | null }): boolean {
  const status = failure.status;
  if (status === undefined || status === null || status === 0) return true;
  return status === 502 || status === 503 || status === 504;
}
