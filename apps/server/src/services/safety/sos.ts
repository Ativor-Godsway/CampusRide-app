import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { sendSms } from "../sms/sendSms";
import { logger } from "../../lib/logger";
import { rideStatusLabel } from "./rideStatusLabels";

/** Ride statuses during which an SOS makes sense — the rider is mid-journey. */
export const SOS_ACTIVE_STATUSES = ["MATCHED", "ARRIVED", "IN_PROGRESS"] as const;

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
  /** Null when the rider has saved no emergency contact. */
  contactName: string | null;
  contactPhone: string | null;
  /** True when the rider's OWN contact was texted successfully. */
  smsDelivered: boolean;
  /**
   * True when the fixed support number was texted successfully. This is the
   * backstop that stops an SOS from a rider with no saved contact reaching
   * nobody at all.
   */
  supportNotified: boolean;
  /** False when the rider should be nudged to add a contact. */
  hasEmergencyContact: boolean;
}

/** One SMS segment. Past this a message is split and can arrive out of order. */
export const SMS_SEGMENT_LIMIT = 160;

/** Shortens `value` to `max` characters, ending on a full word where it can. */
function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max).trimEnd();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** "Kofi Owusu Mensah" -> "Kofi". Used when the full name will not fit. */
function firstName(value: string): string {
  return value.split(" ")[0] ?? value;
}

/**
 * Composes the SOS message, guaranteed to fit ONE 160-character SMS segment.
 *
 * Ghanaian SMS is billed per segment and a split message can arrive out of
 * order, so the limit is a hard constraint rather than a target.
 *
 * Rather than pre-dividing the budget (which shortens things that would have
 * fit), this builds the ideal message and falls back through progressively
 * terser variants, taking the first that fits. The order reflects what is
 * worth most to someone reading this in an emergency:
 *
 *   1. everything
 *   2. driver's first name only — the PLATE identifies the car better than a
 *      surname does, so the name gives way first
 *   3. clamped zone names
 *   4. no driver detail at all
 *   5. status and link only
 *
 * The tracking URL is never truncated: a broken link is worse than no link.
 * There is deliberately no "call them now" nudge here — that lives on the
 * tracking page, where there is room for it.
 *
 * The status is the human label ("On the trip"), never the raw enum: the
 * reader is an alarmed friend, not a developer.
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
  const status = rideStatusLabel(input.status);
  const url = input.trackingUrl;

  const driverPart = (name: string | null): string => {
    if (!name) return " No driver yet.";
    return ` Driver ${name}${input.plate ? ` ${input.plate}` : ""}.`;
  };

  const compose = (rider: string, pickup: string, dropoff: string, driver: string): string =>
    `SOS: ${rider}. ${pickup} to ${dropoff}. ${status}.${driver} ${url}`;

  const rider = clamp(input.riderName, 24);
  const { pickupZone, dropoffZone, driverName } = input;

  const candidates = [
    compose(rider, pickupZone, dropoffZone, driverPart(driverName)),
    compose(rider, pickupZone, dropoffZone, driverPart(driverName && firstName(driverName))),
    compose(
      rider,
      clamp(pickupZone, 14),
      clamp(dropoffZone, 14),
      driverPart(driverName && firstName(driverName)),
    ),
    compose(rider, clamp(pickupZone, 14), clamp(dropoffZone, 14), ""),
    `SOS: ${rider}. ${status}. ${url}`,
  ];

  const fits = candidates.find((c) => c.length <= SMS_SEGMENT_LIMIT);
  if (fits) return fits;

  // Pathological (a base URL long enough to eat the whole budget): send the
  // link and nothing else rather than a message that splits across segments.
  return `SOS. ${url}`;
}

/** Sends one SOS SMS, converting any failure into `false`. Never throws. */
async function trySendSms(
  phone: string,
  message: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    const result = await sendSms(phone, message);
    return result.success;
  } catch (err) {
    logger.error("SOS SMS failed to send", { ...context, err });
    return false;
  }
}

/**
 * Raises an SOS for an active ride: notifies the rider's emergency contact
 * AND a fixed support number by SMS, with the current ride state and a link
 * to the live tracking page.
 *
 * Support is notified on EVERY SOS, not just as a fallback, and is what makes
 * the button meaningful for a rider who never saved a contact — previously
 * that rider's SOS was refused outright and reached nobody. A missing
 * emergency contact is therefore no longer an error; it is reported back so
 * the app can nudge the rider to add one.
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
  supportPhone: string,
): Promise<SosResult> {
  const [rider, ride] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: riderId } }),
    prisma.ride.findUniqueOrThrow({
      where: { id: rideId },
      include: { pickupZone: true, dropoffZone: true },
    }),
  ]);

  if (!(SOS_ACTIVE_STATUSES as readonly string[]).includes(ride.status)) {
    throw new RideNotActiveError();
  }

  const hasEmergencyContact = Boolean(rider.emergencyContactPhone && rider.emergencyContactName);

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

  // Both sends are independent and neither can fail the other: a rider whose
  // own contact is unreachable must still reach support, and vice versa.
  const [smsDelivered, supportNotified] = await Promise.all([
    hasEmergencyContact
      ? trySendSms(rider.emergencyContactPhone!, message, { rideId, riderId, to: "contact" })
      : Promise.resolve(false),
    supportPhone
      ? trySendSms(supportPhone, `[SUPPORT] ${message}`, { rideId, riderId, to: "support" })
      : Promise.resolve(false),
  ]);

  logger.warn("SOS raised", {
    rideId,
    riderId,
    status: ride.status,
    hasEmergencyContact,
    smsDelivered,
    supportNotified,
    // Loud enough to find in a log search when nothing at all got through.
    reachedNobody: !smsDelivered && !supportNotified,
  });

  return {
    trackingUrl,
    contactName: rider.emergencyContactName,
    contactPhone: rider.emergencyContactPhone,
    smsDelivered,
    supportNotified,
    hasEmergencyContact,
  };
}
