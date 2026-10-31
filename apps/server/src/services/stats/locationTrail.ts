import type { PrismaClient } from "@prisma/client";
import type { LatLng } from "@rida/shared";
import { logger } from "../../lib/logger";
import { noteDriversHeard } from "./driverSessions";

/**
 * Where online drivers were, for safety reports and service quality (the
 * admin dashboard later; the privacy policy says so): about one point per
 * driver every SAMPLE_MS, from the positions their app already sends over
 * the socket (idle every 5 s, on a trip every 4 s; realtime/rideSocket.ts).
 *
 * Kept light: points wait in memory and go to the database in one insert
 * per FLUSH_MS (with the drivers' online sessions marked as seen), so a
 * position costs no database write of its own. A restart loses at most one
 * batch. Points are deleted after LOCATION_TRAIL_KEEP_DAYS.
 *
 * Positions and phone numbers are never logged.
 */

/** At most one point per driver this often. */
export const SAMPLE_MS = 30_000;
/** Buffered points are written this often. */
export const FLUSH_MS = 60_000;
/** Kept this long, then deleted (privacy policy: 90 days). */
export const LOCATION_TRAIL_KEEP_DAYS = 90;
/** Ceiling on points waiting in memory, so a database outage can't grow it without bound. */
const MAX_BUFFERED = 20_000;

interface Point {
  driverUserId: string;
  latitude: number;
  longitude: number;
  recordedAt: Date;
  onTrip: boolean;
}

let buffer: Point[] = [];
/** Driver -> when their last point was kept. */
const lastSampled = new Map<string, number>();
/** Driver -> when they were last heard from at all, since the last flush. */
let heard = new Map<string, Date>();

/** A position from a driver's app: kept if their last kept point is SAMPLE_MS old. */
export function noteDriverPosition(
  driverUserId: string,
  point: LatLng,
  onTrip: boolean,
  now: number = Date.now(),
): void {
  heard.set(driverUserId, new Date(now));
  const last = lastSampled.get(driverUserId);
  if (last !== undefined && now - last < SAMPLE_MS) return;
  if (buffer.length >= MAX_BUFFERED) return;
  lastSampled.set(driverUserId, now);
  buffer.push({ driverUserId, latitude: point.latitude, longitude: point.longitude, recordedAt: new Date(now), onTrip });
}

/** Writes the buffered points and the drivers heard from. Run every FLUSH_MS (index.ts). Never throws. */
export async function flushLocationTrail(prisma: PrismaClient): Promise<number> {
  const points = buffer;
  const seen = heard;
  buffer = [];
  heard = new Map();
  try {
    if (points.length > 0) await prisma.driverLocationPoint.createMany({ data: points });
    await noteDriversHeard(prisma, seen);
    // Forget sampling state of drivers long gone, so memory stays flat.
    const cutoff = Date.now() - 10 * SAMPLE_MS;
    for (const [id, at] of lastSampled) if (at < cutoff) lastSampled.delete(id);
    return points.length;
  } catch (err) {
    logger.warn("location trail: write failed", { err, points: points.length });
    return 0;
  }
}

/**
 * Deletes points older than LOCATION_TRAIL_KEEP_DAYS, in batches (one pass
 * deletes at most MAX_PER_RUN; the next carries on). Safe to run twice at
 * once. Run at startup and every few hours (index.ts). Returns how many.
 */
export async function purgeOldLocationPoints(prisma: PrismaClient, now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - LOCATION_TRAIL_KEEP_DAYS * 24 * 60 * 60_000);
  const BATCH = 5_000;
  const MAX_PER_RUN = 500_000;
  let deleted = 0;
  while (deleted < MAX_PER_RUN) {
    const count = await prisma.$executeRaw`
      DELETE FROM "DriverLocationPoint" WHERE id IN (
        SELECT id FROM "DriverLocationPoint" WHERE "recordedAt" < ${before} LIMIT ${BATCH}
      )`;
    deleted += count;
    if (count < BATCH) break;
  }
  return deleted;
}

/** Tests only. */
export function resetLocationTrailForTests(): void {
  buffer = [];
  heard = new Map();
  lastSampled.clear();
}
