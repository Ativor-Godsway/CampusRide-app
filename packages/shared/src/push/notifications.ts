/**
 * Push notifications (Expo push service): what each one says, which Android
 * channel it uses, and where tapping it goes. Shared by the server (which
 * writes the text) and the rider/driver apps (which create the channels and
 * route taps), so the three can never disagree.
 *
 * Privacy rule: the text names nobody but by first name — no surnames, phone
 * numbers, plates or exact coordinates. Notification text shows on a locked
 * screen.
 */
import { firstName } from "../rides/tripStops";

/** What happened. Rider kinds go to the rider app, driver kinds to the driver app. */
export const RIDER_PUSH_KINDS = [
  "DRIVER_ASSIGNED",
  "DRIVER_ARRIVING",
  "DRIVER_ARRIVED",
  "TRIP_STARTED",
  "TRIP_COMPLETED",
  "DRIVER_CANCELLED",
  "NO_DRIVER_FOUND",
] as const;
export const DRIVER_PUSH_KINDS = ["RIDE_REQUEST", "RIDER_CANCELLED", "WENT_OFFLINE"] as const;

export type RiderPushKind = (typeof RIDER_PUSH_KINDS)[number];
export type DriverPushKind = (typeof DRIVER_PUSH_KINDS)[number];
export type PushKind = RiderPushKind | DriverPushKind;

export type PushApp = "rider" | "driver";

/** The `data` payload every CampusRide notification carries. */
export interface PushData {
  kind: PushKind;
  rideId: string;
}

export interface AndroidChannelSpec {
  id: string;
  /** Shown in Android's notification settings for the app. */
  name: string;
  description: string;
}

/**
 * One Android channel per app. Every notification an app receives uses its
 * channel, so a person can tune them in Android settings under that name.
 */
export const ANDROID_CHANNELS: Record<PushApp, AndroidChannelSpec> = {
  rider: {
    id: "ride-updates",
    name: "Ride updates",
    description: "Your driver's progress and changes to your ride.",
  },
  driver: {
    id: "ride-requests",
    name: "Ride requests",
    description: "New ride requests near you and changes to your trip.",
  },
};

export function appForKind(kind: PushKind): PushApp {
  return (DRIVER_PUSH_KINDS as readonly string[]).includes(kind) ? "driver" : "rider";
}

export function isPushKind(value: unknown): value is PushKind {
  return (
    typeof value === "string" &&
    ((RIDER_PUSH_KINDS as readonly string[]).includes(value) ||
      (DRIVER_PUSH_KINDS as readonly string[]).includes(value))
  );
}

/** Reads CampusRide's payload out of a notification's `data`, or null if it isn't one of ours. */
export function parsePushData(data: unknown): PushData | null {
  if (typeof data !== "object" || data === null) return null;
  const { kind, rideId } = data as Record<string, unknown>;
  if (!isPushKind(kind) || typeof rideId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(rideId))
    return null;
  return { kind, rideId };
}

export interface PushTextInput {
  /** Full name as stored; only the first word is ever used. */
  driverName?: string | null;
  riderName?: string | null;
  /** RIDE_REQUEST: the pickup's place or zone name, e.g. "Balme Library". */
  pickupName?: string | null;
  /** DRIVER_CANCELLED: the driver marked the rider as not at the pickup. */
  noShow?: boolean;
}

export interface PushText {
  title: string;
  body: string;
}

/** The title and body for a notification. Names are reduced to a first name. */
export function pushText(kind: PushKind, input: PushTextInput = {}): PushText {
  const driver = firstName(input.driverName) || "Your driver";
  const rider = firstName(input.riderName) || "The rider";
  switch (kind) {
    case "DRIVER_ASSIGNED":
      return { title: "Driver on the way", body: `${driver} is coming to pick you up.` };
    case "DRIVER_ARRIVING":
      return { title: "Driver almost there", body: `${driver} is almost at your pickup.` };
    case "DRIVER_ARRIVED":
      return { title: "Your driver is here", body: `${driver} is at your pickup.` };
    case "TRIP_STARTED":
      return { title: "Trip started", body: "You're on your way. Enjoy the ride." };
    case "TRIP_COMPLETED":
      return { title: "Trip complete", body: "Thanks for riding with CampusRide." };
    case "DRIVER_CANCELLED":
      return input.noShow
        ? {
            title: "Pickup cancelled",
            body: `${driver} couldn't find you at the pickup and cancelled it.`,
          }
        : {
            title: "Pickup cancelled",
            body: `${driver} cancelled your pickup. You can request another ride.`,
          };
    case "NO_DRIVER_FOUND":
      return {
        title: "No driver yet",
        body: "Open CampusRide to keep waiting or change your ride.",
      };
    case "RIDE_REQUEST":
      return {
        title: "New ride request",
        body: input.pickupName
          ? `Pickup at ${input.pickupName}. Open the app to accept.`
          : "Open the app to accept.",
      };
    case "RIDER_CANCELLED":
      return { title: "Ride cancelled", body: `${rider} cancelled the ride.` };
    case "WENT_OFFLINE":
      return {
        title: "You're offline",
        body: "We lost touch with your phone for a while. Go online again when you're ready.",
      };
  }
}

/**
 * Where tapping a notification takes the person:
 * - "trip": the ride's screen (rider: their active ride; driver: /ride/:id)
 * - "rides": the rider's ride history (the trip is over)
 * - "home": the start screen (driver: where the request's offer pops up)
 */
export type PushTapTarget = "trip" | "rides" | "home";

export function pushTapTarget(kind: PushKind): PushTapTarget {
  switch (kind) {
    case "TRIP_COMPLETED":
      return "rides";
    case "RIDE_REQUEST":
    case "DRIVER_CANCELLED":
    case "WENT_OFFLINE":
      return "home";
    default:
      return "trip";
  }
}
