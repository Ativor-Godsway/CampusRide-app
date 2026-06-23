import type { RideType } from "@rida/shared";
import type { ZoneGroupKey } from "./zoneGroups";

export type UssdStep =
  | "MAIN"
  | "PICKUP_GROUP"
  | "PICKUP_ZONE"
  | "DROPOFF_GROUP"
  | "DROPOFF_ZONE"
  | "RIDE_TYPE"
  | "CONFIRM";

export interface ZoneSelection {
  id: string;
  name: string;
}

export interface UssdSessionState {
  step: UssdStep;
  msisdn: string;
  pickupGroup?: ZoneGroupKey;
  /** The ordered zone list rendered for the CURRENT zone-picking step, so the next numeric reply maps unambiguously back to a Zone. */
  pendingZoneChoices?: ZoneSelection[];
  pickupZone?: ZoneSelection;
  dropoffGroup?: ZoneGroupKey;
  dropoffZone?: ZoneSelection;
  rideType?: RideType;
}

/**
 * In-memory session store keyed by Moolre's sessionId — explicitly NOT a DB
 * table (demo-grade decision). A session lives only as long as the process;
 * a restart drops every in-flight USSD session, which is an accepted
 * tradeoff for the buildathon. Entries are deleted when a session ends
 * (reply:false) so this never grows unbounded across a long-running demo.
 */
const sessions = new Map<string, UssdSessionState>();

export function getSession(sessionId: string): UssdSessionState | undefined {
  return sessions.get(sessionId);
}

export function startSession(sessionId: string, msisdn: string): UssdSessionState {
  const state: UssdSessionState = { step: "MAIN", msisdn };
  sessions.set(sessionId, state);
  return state;
}

export function endSession(sessionId: string): void {
  sessions.delete(sessionId);
}
