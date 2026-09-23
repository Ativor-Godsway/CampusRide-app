import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sendSms } from "../sms/sendSms";
import { logger } from "../../lib/logger";

/** Ride statuses during which an SOS makes sense — the rider is mid-journey. */
export const SOS_ACTIVE_STATUSES = ["MATCHED", "ARRIVED", "IN_PROGRESS"] as const;

export class NoEmergencyContactError extends Error {
  constructor() {
    super("No emergency contact set");
    this.name = "NoEmergencyContactError";
  }
}

export class RideNotActiveError extends Error {
  constructor() {
    super("SOS is only available during an active ride");
    this.name = "RideNotActiveError";
  }
}

/**
 * 32 hex chars from a CSPRNG. This token is the ONLY credential protecting
 * the public tracking page, so it has to be unguessable — a sequential id or
 * the ride's cuid would let anyone enumerate other people's live rides.
 */
function mintTrackingToken(): string {
  return randomBytes(16).toString("hex");
}

export interface SosResult {
  trackingUrl: string;
  contactName: string;
  contactPhone: string;
  /** False when the SMS provider is disabled or the send failed. */
  smsDelivered: boolean;
}

/**
 * Composes the SOS message.
 *
 * Kept deliberately short: Ghanaian SMS is billed per 160-character segment,
 * and multi-segment messages can arrive out of order on some networks. Leads
 * with "SOS" and the rider's name so the recipient understands it from the
 * notification preview, without having to open it first.
 */
export function buildSosMessage(input: {
  riderName: string;
  status: string;
  pickupZone: string;
  dropoffZone: string;
  driverName: string | null;
  plate: string | null;
  trackingUrl: string;
}): string {
  const vehicle = input.driverName
    ? `Driver: ${input.driverName}${input.plate ? ` (${input.plate})` : ""}.`
    : "No driver assigned yet.";

  return [
    `SOS from ${input.riderName} on CampusRide.`,
    `${input.pickupZone} to ${input.dropoffZone}. Status: ${input.status}.`,
    vehicle,
    `Track: ${input.trackingUrl}`,
  ].join(" ");
}

/**
 * Raises an SOS for an active ride: notifies the rider's emergency contact by
 * SMS with the current ride state and a link to the live tracking page.
 *
 * The tracking token is minted once per ride and REUSED by later SOS calls,
 * so a link already sent to a contact keeps working rather than going dead
 * the moment the rider taps SOS again.
 *
 * A failed SMS does NOT throw. A half-working SOS is still worth reporting:
 * the tracking URL is returned either way so the rider can share it another
 * way, and throwing would make the button look broken at the worst possible
 * moment.
 */
export async function raiseSos(
  prisma: PrismaClient,
  rideId: string,
  riderId: string,
  baseUrl: string,
): Promise<SosResult> {
  const [rider, ride] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: riderId } }),
    prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { pickupZone: true, dropoffZone: true },
    }),
  ]);

  if (!rider.emergencyContactPhone || !rider.emergencyContactName) {
    throw new NoEmergencyContactError();
  }
  if (!(SOS_ACTIVE_STATUSES as readonly string[]).includes(ride.status)) {
    throw new RideNotActiveError();
  }

  let token = ride.trackingToken;
  if (!token) {
    token = mintTrackingToken();
    await prisma.ride.update({ where: { id: rideId }, data: { trackingToken: token } });
  }
  const trackingUrl = `${baseUrl.replace(/\/+$/, "")}/track/${token}`;

  const driver = ride.driverId
    ? await prisma.user.findUnique({ where: { id: ride.driverId }, include: { driver: true } })
    : null;

  const message = buildSosMessage({
    riderName: rider.name,
    status: ride.status,
    pickupZone: ride.pickupZone.name,
    dropoffZone: ride.dropoffZone.name,
    driverName: driver?.name ?? null,
    plate: driver?.driver?.plate ?? null,
    trackingUrl,
  });

  let smsDelivered = false;
  try {
    const result = await sendSms(rider.emergencyContactPhone, message);
    smsDelivered = result.success;
  } catch (err) {
    // Never rethrow: see the doc comment above.
    logger.error("SOS SMS failed to send", { rideId, riderId, err });
  }

  logger.warn("SOS raised", { rideId, riderId, smsDelivered, status: ride.status });

  return {
    trackingUrl,
    contactName: rider.emergencyContactName,
    contactPhone: rider.emergencyContactPhone,
    smsDelivered,
  };
}
