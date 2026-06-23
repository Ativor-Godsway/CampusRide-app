import type { PrismaClient } from "@prisma/client";
import type { RideType } from "@rida/shared";
import { getLoneFare, getSharedFarePerRider } from "@rida/shared";
import { normalizePhone } from "../../lib/phone";
import { createRide, ActiveRideExistsError, ZoneNotFoundError, SameZoneError, ACTIVE_RIDE_STATUSES } from "../ride/createRide";
import { findOrCreateRiderByPhone, InvalidPhoneError } from "./findOrCreateRiderByPhone";
import {
  ZONE_GROUP_ORDER,
  ZONE_GROUP_LABELS,
  zoneGroupFromMenuChoice,
  getZonesInGroup,
} from "./zoneGroups";
import { getSession, startSession, endSession, type UssdSessionState, type ZoneSelection } from "./session";

export interface MoolreUssdRequest {
  sessionId: string;
  new: boolean;
  msisdn: string;
  message: string;
}

export interface MoolreUssdResponse {
  message: string;
  reply: boolean;
}

const MAIN_MENU = "CampusRide\n1. Request a ride\n2. Check ride status\n3. Make payment";
const INVALID_CHOICE_PREFIX = "Invalid choice.\n";

/** A graceful, session-ending response for any unexpected/unrecoverable failure mid-flow. */
function endWith(message: string, sessionId: string): MoolreUssdResponse {
  endSession(sessionId);
  return { message, reply: false };
}

function groupMenuText(header: string): string {
  const lines = ZONE_GROUP_ORDER.map((key, i) => `${i + 1}. ${ZONE_GROUP_LABELS[key]}`);
  return `${header}\n${lines.join("\n")}`;
}

function zoneMenuText(header: string, zones: ZoneSelection[]): string {
  const lines = zones.map((z, i) => `${i + 1}. ${z.name}`);
  return `${header}\n${lines.join("\n")}`;
}

function rideTypeMenuText(): string {
  return `Ride type:\n1. Shared (GHS ${getSharedFarePerRider(1) / 100})\n2. Lone (GHS ${getLoneFare() / 100})`;
}

function confirmMenuText(state: UssdSessionState): string {
  const typeLabel = state.rideType === "SHARED" ? "Shared" : "Lone";
  const farePesewas = state.rideType === "SHARED" ? getSharedFarePerRider(1) : getLoneFare();
  return (
    `Confirm ride:\n` +
    `From: ${state.pickupZone?.name}\n` +
    `To: ${state.dropoffZone?.name}\n` +
    `Type: ${typeLabel} (GHS ${farePesewas / 100})\n` +
    `1. Confirm\n2. Cancel`
  );
}

/** Parses a USSD menu reply as a 1-based integer choice, or null if not a positive integer. */
function parseChoice(message: string): number | null {
  const trimmed = message.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n > 0 ? n : null;
}

const RIDE_STATUS_TEXT: Record<string, string> = {
  REQUESTED: "Looking for a driver...",
  AWAITING_RIDER_DECISION: "Still searching. Dial back to check again.",
  MATCHED: "Driver assigned and on the way.",
  ARRIVED: "Your driver has arrived.",
  IN_PROGRESS: "Trip in progress.",
};

/**
 * Core USSD state machine — pure-ish aside from DB reads/writes and the
 * session Map. Kept separate from the Fastify route so it's directly
 * unit-testable without spinning up the HTTP layer.
 */
export async function handleUssdRequest(
  prisma: PrismaClient,
  body: MoolreUssdRequest,
): Promise<MoolreUssdResponse> {
  const { sessionId, msisdn } = body;

  if (body.new) {
    startSession(sessionId, msisdn);
    return { message: MAIN_MENU, reply: true };
  }

  const session = getSession(sessionId);
  if (!session) {
    // Unknown session on a continuing request — Moolre/our process state
    // disagree (e.g. a server restart dropped the in-memory Map). Reset
    // to the main menu rather than crash or guess at prior state.
    startSession(sessionId, msisdn);
    return { message: MAIN_MENU, reply: true };
  }

  const choice = parseChoice(body.message);

  switch (session.step) {
    case "MAIN": {
      if (choice === 1) {
        session.step = "PICKUP_GROUP";
        return { message: groupMenuText("Pickup location:"), reply: true };
      }
      if (choice === 2) {
        return handleStatusCheck(prisma, sessionId, msisdn);
      }
      if (choice === 3) {
        return endWith("Payment successful (demo). No real charge was made.", sessionId);
      }
      return { message: INVALID_CHOICE_PREFIX + MAIN_MENU, reply: true };
    }

    case "PICKUP_GROUP": {
      const group = choice !== null ? zoneGroupFromMenuChoice(choice) : null;
      if (!group) {
        return { message: INVALID_CHOICE_PREFIX + groupMenuText("Pickup location:"), reply: true };
      }
      const zones = await getZonesInGroup(prisma, group);
      session.pickupGroup = group;
      session.pendingZoneChoices = zones.map((z) => ({ id: z.id, name: z.name }));
      session.step = "PICKUP_ZONE";
      return { message: zoneMenuText("Pickup zone:", session.pendingZoneChoices), reply: true };
    }

    case "PICKUP_ZONE": {
      const zone = pickZone(session, choice);
      if (!zone) {
        return {
          message: INVALID_CHOICE_PREFIX + zoneMenuText("Pickup zone:", session.pendingZoneChoices ?? []),
          reply: true,
        };
      }
      session.pickupZone = zone;
      session.pendingZoneChoices = undefined;
      session.step = "DROPOFF_GROUP";
      return { message: groupMenuText("Dropoff location:"), reply: true };
    }

    case "DROPOFF_GROUP": {
      const group = choice !== null ? zoneGroupFromMenuChoice(choice) : null;
      if (!group) {
        return { message: INVALID_CHOICE_PREFIX + groupMenuText("Dropoff location:"), reply: true };
      }
      const zones = await getZonesInGroup(prisma, group);
      session.dropoffGroup = group;
      session.pendingZoneChoices = zones.map((z) => ({ id: z.id, name: z.name }));
      session.step = "DROPOFF_ZONE";
      return { message: zoneMenuText("Dropoff zone:", session.pendingZoneChoices), reply: true };
    }

    case "DROPOFF_ZONE": {
      const zone = pickZone(session, choice);
      if (!zone) {
        return {
          message: INVALID_CHOICE_PREFIX + zoneMenuText("Dropoff zone:", session.pendingZoneChoices ?? []),
          reply: true,
        };
      }
      if (zone.id === session.pickupZone?.id) {
        // Same zone picked for both ends — re-prompt rather than letting
        // createRide's SameZoneError surface as a dead-end failure later.
        return {
          message:
            "Pickup and dropoff can't be the same zone.\n" +
            zoneMenuText("Dropoff zone:", session.pendingZoneChoices ?? []),
          reply: true,
        };
      }
      session.dropoffZone = zone;
      session.pendingZoneChoices = undefined;
      session.step = "RIDE_TYPE";
      return { message: rideTypeMenuText(), reply: true };
    }

    case "RIDE_TYPE": {
      const rideType: RideType | null = choice === 1 ? "SHARED" : choice === 2 ? "LONE" : null;
      if (!rideType) {
        return { message: INVALID_CHOICE_PREFIX + rideTypeMenuText(), reply: true };
      }
      session.rideType = rideType;
      session.step = "CONFIRM";
      return { message: confirmMenuText(session), reply: true };
    }

    case "CONFIRM": {
      if (choice === 2) {
        return endWith("Ride request cancelled.", sessionId);
      }
      if (choice !== 1) {
        return { message: INVALID_CHOICE_PREFIX + confirmMenuText(session), reply: true };
      }
      return finalizeRideRequest(prisma, sessionId, session);
    }

    default:
      // STATUS/PAYMENT are single-shot (handled inline above) and never
      // become the stored step, but guard anyway rather than throw.
      startSession(sessionId, msisdn);
      return { message: MAIN_MENU, reply: true };
  }
}

function pickZone(session: UssdSessionState, choice: number | null): ZoneSelection | null {
  if (choice === null || !session.pendingZoneChoices) return null;
  return session.pendingZoneChoices[choice - 1] ?? null;
}

async function finalizeRideRequest(
  prisma: PrismaClient,
  sessionId: string,
  session: UssdSessionState,
): Promise<MoolreUssdResponse> {
  if (!session.pickupZone || !session.dropoffZone || !session.rideType) {
    // Defensive — CONFIRM is only reachable after all three are set.
    return endWith("Something went wrong with your request. Please dial back and try again.", sessionId);
  }

  let riderId: string;
  try {
    const user = await findOrCreateRiderByPhone(prisma, session.msisdn);
    riderId = user.id;
  } catch (err) {
    if (err instanceof InvalidPhoneError) {
      return endWith("We couldn't process your phone number. Please try again later.", sessionId);
    }
    throw err;
  }

  try {
    await createRide(prisma, {
      riderId,
      type: session.rideType,
      pickupZoneId: session.pickupZone.id,
      dropoffZoneId: session.dropoffZone.id,
      source: "USSD",
    });
  } catch (err) {
    if (err instanceof ActiveRideExistsError) {
      return endWith("You already have an active ride. Dial back and choose Check Status.", sessionId);
    }
    if (err instanceof SameZoneError || err instanceof ZoneNotFoundError) {
      // Shouldn't happen — zones came from getZonesInGroup and same-zone is
      // already rejected at DROPOFF_ZONE — but fail gracefully, not silently.
      return endWith("Something went wrong with your request. Please dial back and try again.", sessionId);
    }
    throw err;
  }

  return endWith("Request sent! Looking for a driver. You'll get an SMS when matched.", sessionId);
}

async function handleStatusCheck(
  prisma: PrismaClient,
  sessionId: string,
  msisdn: string,
): Promise<MoolreUssdResponse> {
  const phone = normalizePhone(msisdn);
  if (!phone) {
    return endWith("We couldn't process your phone number. Please try again later.", sessionId);
  }

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) {
    return endWith("You have no active ride.", sessionId);
  }

  const ride = await prisma.ride.findFirst({
    where: { riderId: user.id, status: { in: ACTIVE_RIDE_STATUSES } },
    orderBy: { createdAt: "desc" },
  });

  if (!ride) {
    return endWith("You have no active ride.", sessionId);
  }

  const text = RIDE_STATUS_TEXT[ride.status] ?? "Your ride status is unavailable right now.";
  return endWith(text, sessionId);
}
