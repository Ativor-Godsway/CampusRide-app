/**
 * Fills a LOCAL development database with about two weeks of realistic
 * pilot data, so every page of the admin dashboard shows something: riders
 * and drivers (one waiting for approval, one suspended), online sessions,
 * ride requests at campus places with offers and every outcome (completed
 * alone and shared, cancelled by rider or driver, no driver found), a few
 * trips under way now, ratings, location trail points, cash payments with a
 * reversal, and two SOS alerts (one open). Plus an admin account to sign in
 * with ("Seed Admin").
 *
 *   npm run seed:dashboard:dev --workspace=apps/server
 *
 * Refuses to run against anything but Postgres on this machine (localhost),
 * and always refuses the production database. Every account it makes has a
 * phone number in the reserved range +23320099xxxx; running it again first
 * deletes what it made before (nothing else).
 */
import { PrismaClient, type PassengerStatus, type RideOfferOutcome } from "@prisma/client";
import { splitFare } from "@rida/shared";

const PHONE_PREFIX = "+23320099";
const DAYS = 14;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LONE_FARE = 1500;
const SHARED_FARE = 700;

function refuseUnlessLocal(url: string | undefined): void {
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (url.includes("ep-empty-violet")) throw new Error("Refusing: DATABASE_URL is the PRODUCTION database.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("Refusing: DATABASE_URL isn't a URL.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing: this seeds a LOCAL database only, and DATABASE_URL points at ${host}.`);
  }
}

/** A repeatable random number generator, so two runs make the same story. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const random = rng(20261031);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
const between = (a: number, b: number) => a + random() * (b - a);

const FIRST = ["Ama", "Yaw", "Efua", "Kojo", "Abena", "Kwesi", "Akua", "Kofi", "Esi", "Kwabena", "Adwoa", "Fiifi", "Afia", "Nana", "Mawuli", "Selorm", "Dzifa", "Elikem", "Naa", "Nii"];
const LAST = ["Owusu", "Boateng", "Mensah", "Asante", "Darko", "Kuffour", "Agyeman", "Addo", "Ofori", "Tetteh", "Quaye", "Amoah", "Badu", "Antwi", "Sarpong"];
const CARS = [
  ["Toyota", "Vitz", "Green"],
  ["Toyota", "Corolla", "Silver"],
  ["Hyundai", "Elantra", "Blue"],
  ["Kia", "Picanto", "Red"],
  ["Toyota", "Yaris", "White"],
  ["Honda", "Fit", "Black"],
  ["Nissan", "Almera", "Grey"],
  ["Suzuki", "Swift", "Yellow"],
] as const;

async function main() {
  refuseUnlessLocal(process.env.DATABASE_URL);
  refuseUnlessLocal(process.env.DIRECT_URL ?? process.env.DATABASE_URL);
  const prisma = new PrismaClient();
  const now = Date.now();
  const start = now - DAYS * DAY;

  // ── Forget the last run ─────────────────────────────────────────────────
  const old = await prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const oldIds = old.map((u) => u.id);
  if (oldIds.length) {
    const oldRides = await prisma.ride.findMany({ where: { OR: [{ riderId: { in: oldIds } }, { driverId: { in: oldIds } }] }, select: { id: true } });
    const rideIds = oldRides.map((r) => r.id);
    await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: oldIds }, reversesId: { not: null } } });
    await prisma.driverCashPayment.deleteMany({ where: { driverUserId: { in: oldIds } } });
    await prisma.commissionLedger.deleteMany({ where: { OR: [{ driverUserId: { in: oldIds } }, { rideId: { in: rideIds } }] } });
    await prisma.rating.deleteMany({ where: { OR: [{ rideId: { in: rideIds } }, { raterId: { in: oldIds } }, { rateeId: { in: oldIds } }] } });
    await prisma.ridePassenger.deleteMany({ where: { OR: [{ rideId: { in: rideIds } }, { riderId: { in: oldIds } }] } });
    await prisma.ride.updateMany({ where: { mergedIntoRideId: { in: rideIds } }, data: { mergedIntoRideId: null } });
    await prisma.ride.deleteMany({ where: { id: { in: rideIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actor: { in: oldIds } } });
    await prisma.driver.deleteMany({ where: { userId: { in: oldIds } } });
    await prisma.user.deleteMany({ where: { id: { in: oldIds } } });
    console.log(`Removed the previous seed (${oldIds.length} accounts, ${rideIds.length} rides).`);
  }

  const places = await prisma.place.findMany({
    where: { isActive: true, zone: { retiredAt: null } },
    select: { id: true, name: true, latitude: true, longitude: true, zoneId: true },
  });
  if (places.length < 10) throw new Error("Seed the places first (npm run db:seed:dev): fewer than 10 active places.");
  // Busy spots get picked more often.
  const busy = places.filter((p) => /hall|market|library|gate|hostel|ugbs|pent|bush/i.test(p.name));
  const pickPlace = () => (random() < 0.6 && busy.length ? pick(busy) : pick(places));

  let phoneNo = 0;
  const phone = () => `${PHONE_PREFIX}${String(++phoneNo).padStart(4, "0")}`;
  const person = () => `${pick(FIRST)} ${pick(LAST)}`;

  // ── People ──────────────────────────────────────────────────────────────
  const admin = await prisma.user.create({ data: { phone: phone(), name: "Seed Admin", role: "ADMIN", createdAt: new Date(start - 30 * DAY) } });

  const riders = [];
  for (let i = 0; i < 70; i++) {
    const joined = start - 20 * DAY + random() * (DAYS + 20) * DAY;
    riders.push(
      await prisma.user.create({
        data: {
          phone: phone(),
          name: person(),
          role: "RIDER",
          createdAt: new Date(Math.min(joined, now - HOUR)),
          earlyAccessAt: random() < 0.4 ? new Date(start) : null,
          emergencyContactName: random() < 0.5 ? "Auntie" : null,
          emergencyContactPhone: null,
        },
      }),
    );
  }

  const drivers: Array<{ userId: string; driverId: string; name: string; reliability: number }> = [];
  for (let i = 0; i < 8; i++) {
    const [make, model, color] = CARS[i]!;
    const user = await prisma.user.create({ data: { phone: phone(), name: person(), role: "DRIVER", createdAt: new Date(start - 25 * DAY + i * DAY) } });
    const pending = i === 7;
    const suspended = i === 6;
    const d = await prisma.driver.create({
      data: {
        userId: user.id,
        carMake: make,
        carModel: model,
        carColor: color,
        plate: `G${pick(["T", "R", "W", "E"])} ${1000 + Math.floor(random() * 8999)}-${pick(["21", "22", "23", "24"])}`,
        isApproved: !pending,
        suspendedAt: suspended ? new Date(now - 2 * DAY) : null,
        suspendedReason: suspended ? "Two riders reported speeding on Akilagpa Sawyerr Road" : null,
        suspendedBy: suspended ? admin.id : null,
        createdAt: new Date(start - 25 * DAY + i * DAY),
      },
    });
    if (!pending) drivers.push({ userId: user.id, driverId: d.id, name: user.name, reliability: suspended ? 0.6 : between(0.75, 0.97) });
  }
  const active = drivers.slice(0, 6);

  // ── Online sessions (morning and evening shifts) ───────────────────────
  type Shift = { driverUserId: string; startedAt: number; endedAt: number };
  const shifts: Shift[] = [];
  for (let day = 0; day <= DAYS; day++) {
    const midnight = Math.floor((start + day * DAY) / DAY) * DAY;
    for (const d of drivers) {
      if (d === drivers[6] && day > DAYS - 2) continue; // suspended two days ago
      const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
      if (random() < 0.7) {
        const s = midnight + between(6.5, 8.5) * HOUR;
        shifts.push({ driverUserId: d.userId, startedAt: s, endedAt: s + between(1.5, 3.5) * HOUR });
      }
      if (random() < 0.4) {
        const s = midnight + between(10.5, 13) * HOUR;
        shifts.push({ driverUserId: d.userId, startedAt: s, endedAt: s + between(1.5, 3) * HOUR });
      }
      // Fewer drivers in the evening, especially Friday and Saturday: the gap the dashboard should find.
      if (random() < (weekday >= 4 && weekday <= 5 ? 0.35 : 0.55)) {
        const s = midnight + between(16, 18) * HOUR;
        shifts.push({ driverUserId: d.userId, startedAt: s, endedAt: s + between(2, 4.5) * HOUR });
      }
    }
  }
  const pastShifts = shifts.filter((s) => s.startedAt < now);
  await prisma.driverOnlineSession.createMany({
    data: pastShifts.map((s) => ({
      driverUserId: s.driverUserId,
      startedAt: new Date(s.startedAt),
      endedAt: s.endedAt < now ? new Date(s.endedAt) : null,
      lastSeenAt: new Date(Math.min(s.endedAt, now)),
      endReason: s.endedAt < now ? (random() < 0.1 ? "TIMEOUT" : "OFFLINE") : null,
    })),
  });
  const onlineAt = (t: number) => pastShifts.filter((s) => s.startedAt <= t && t < s.endedAt).map((s) => s.driverUserId);

  // ── Ride requests ───────────────────────────────────────────────────────
  const hourWeights = [0, 0, 0, 0, 0, 0, 0.2, 1.4, 2, 1.2, 0.6, 0.6, 0.9, 0.8, 0.6, 0.7, 1, 1.6, 2.2, 2, 1.2, 0.7, 0.4, 0.1];
  const totalWeight = hourWeights.reduce((a, b) => a + b, 0);
  const pickHour = () => {
    let r = random() * totalWeight;
    for (let h = 0; h < 24; h++) {
      r -= hourWeights[h]!;
      if (r <= 0) return h;
    }
    return 18;
  };

  let made = 0;
  let completed = 0;
  const completedRides: Array<{ id: string; driverUserId: string; at: number; riders: string[] }> = [];
  for (let day = 0; day <= DAYS; day++) {
    const midnight = Math.floor((start + day * DAY) / DAY) * DAY;
    const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
    const requests = Math.round(between(14, 26) * (weekday >= 4 ? 1.3 : 1));
    for (let i = 0; i < requests; i++) {
      const created = midnight + pickHour() * HOUR + random() * HOUR;
      if (created > now - 25 * MIN) continue;
      const from = pickPlace();
      let to = pickPlace();
      while (to.id === from.id) to = pickPlace();
      const shared = random() < 0.6;
      const rider = pick(riders);
      const online = onlineAt(created);
      const eligible = online.filter(() => random() < 0.9);
      const taker = eligible.find((id) => random() < (drivers.find((d) => d.userId === id)?.reliability ?? 0.8)) ?? null;
      const riderGivesUpFirst = random() < 0.07;

      let status: "COMPLETED" | "CANCELLED" | "IN_PROGRESS" = "CANCELLED";
      let cancelReason: "RIDER_CANCELLED" | "DRIVER_BACKED_OUT" | "NO_DRIVERS_AVAILABLE" | null = null;
      let riderCancelReason: "WAITING_TOO_LONG" | "CHANGED_PLANS" | "PRICE" | "DRIVER_TOO_SLOW" | "DRIVER_ASKED_TO_CANCEL" | null = null;
      const matchedAt = taker && !riderGivesUpFirst ? created + between(15, 150) * 1000 : null;
      let completedAt: number | null = null;
      let cancelledAt: number | null = null;
      let noDriverFoundAt: number | null = null;

      if (riderGivesUpFirst) {
        cancelReason = "RIDER_CANCELLED";
        riderCancelReason = pick(["WAITING_TOO_LONG", "CHANGED_PLANS", "PRICE"] as const);
        cancelledAt = created + between(20, 80) * 1000;
      } else if (!matchedAt) {
        cancelReason = "NO_DRIVERS_AVAILABLE";
        noDriverFoundAt = created + 90_000;
        cancelledAt = created + between(100, 200) * 1000;
      } else {
        const roll = random();
        if (roll < 0.04) {
          cancelReason = "DRIVER_BACKED_OUT";
          cancelledAt = matchedAt + between(1, 5) * MIN;
        } else if (roll < 0.1) {
          cancelReason = "RIDER_CANCELLED";
          riderCancelReason = pick(["DRIVER_TOO_SLOW", "CHANGED_PLANS", "DRIVER_ASKED_TO_CANCEL"] as const);
          cancelledAt = matchedAt + between(1, 6) * MIN;
        } else {
          completedAt = matchedAt + between(9, 22) * MIN;
          status = completedAt > now ? "IN_PROGRESS" : "COMPLETED";
          if (status === "IN_PROGRESS") completedAt = null;
        }
      }

      const seatRiders = [rider.id];
      if (shared && (status === "COMPLETED" || status === "IN_PROGRESS") && random() < 0.45) {
        let other = pick(riders);
        while (other.id === rider.id) other = pick(riders);
        seatRiders.push(other.id);
      }
      const fare = shared ? SHARED_FARE : LONE_FARE;
      const seatStatus: PassengerStatus =
        status === "COMPLETED" ? (shared ? "DROPPED_OFF" : "PICKED_UP") : status === "IN_PROGRESS" ? "PICKED_UP" : "CANCELLED";
      const jitter = () => (random() - 0.5) * 0.0004;

      const ride = await prisma.ride.create({
        data: {
          riderId: rider.id,
          driverId: matchedAt ? taker : null,
          type: shared ? "SHARED" : "LONE",
          status,
          pickupZoneId: from.zoneId,
          dropoffZoneId: to.zoneId,
          occupancy: seatRiders.length,
          createdAt: new Date(created),
          broadcastStartedAt: new Date(created),
          matchedAt: matchedAt ? new Date(matchedAt) : null,
          departedAt: matchedAt && (status === "COMPLETED" || status === "IN_PROGRESS") ? new Date(matchedAt + 4 * MIN) : null,
          completedAt: completedAt ? new Date(completedAt) : null,
          cancelledAt: cancelledAt ? new Date(cancelledAt) : null,
          noDriverFoundAt: noDriverFoundAt ? new Date(noDriverFoundAt) : null,
          cancelReason,
          riderCancelReason,
          paymentMethod: "CASH",
          pickupLat: from.latitude + jitter(),
          pickupLng: from.longitude + jitter(),
          pickupLabel: from.name,
          pickupPlaceId: from.id,
          dropoffLat: to.latitude + jitter(),
          dropoffLng: to.longitude + jitter(),
          dropoffLabel: to.name,
          dropoffPlaceId: to.id,
          passengers: {
            create: seatRiders.map((riderId) => ({
              riderId,
              pickupZoneId: from.zoneId,
              dropoffZoneId: to.zoneId,
              status: seatStatus,
              lockedFare: fare,
              fareCharged: status === "COMPLETED" ? fare : null,
              pickupLat: from.latitude,
              pickupLng: from.longitude,
              pickupLabel: from.name,
              dropoffLat: to.latitude,
              dropoffLng: to.longitude,
              dropoffLabel: to.name,
              createdAt: new Date(created),
            })),
          },
        },
      });
      made += 1;

      // Offers: to the drivers who were near, with what each did.
      const offered = [...new Set([...(taker && matchedAt ? [taker] : []), ...eligible])].slice(0, 3);
      if (offered.length) {
        await prisma.rideOffer.createMany({
          data: offered.map((driverUserId) => {
            let outcome: RideOfferOutcome;
            let offeredAt = created;
            let decided = created + between(2, 12) * 1000;
            if (driverUserId === taker && matchedAt) {
              // Offered to them a few seconds before they took it (they may have come online after the first broadcast).
              outcome = "ACCEPTED";
              offeredAt = Math.max(created, matchedAt - between(3, 12) * 1000);
              decided = matchedAt;
            } else if (riderGivesUpFirst) outcome = "CANCELLED";
            else if (!matchedAt) outcome = random() < 0.5 ? "DECLINED" : random() < 0.5 ? "TIMED_OUT" : "EXPIRED";
            else outcome = random() < 0.5 ? "TAKEN" : "DECLINED";
            if (outcome === "TIMED_OUT") decided = created + 15_000;
            if (outcome === "EXPIRED") decided = created + 90_000;
            return { rideId: ride.id, driverUserId, offeredAt: new Date(offeredAt), outcome, decidedAt: new Date(decided) };
          }),
        });
      }

      if (status === "COMPLETED" && taker) {
        completed += 1;
        const total = fare * seatRiders.length;
        await prisma.commissionLedger.create({ data: { driverUserId: taker, rideId: ride.id, amountPesewas: splitFare(total).commission, createdAt: new Date(completedAt!) } });
        completedRides.push({ id: ride.id, driverUserId: taker, at: completedAt!, riders: seatRiders });
      }
    }
  }

  // Drivers on a shift now are online (their last known position at a busy place).
  const onNow = new Set(onlineAt(now));
  for (const d of drivers) {
    const spot = pick(busy.length ? busy : places);
    await prisma.driver.update({
      where: { userId: d.userId },
      data: onNow.has(d.userId) && d !== drivers[6]
        ? { isOnline: true, currentZoneId: spot.zoneId, lastLat: spot.latitude, lastLng: spot.longitude, lastSeenAt: new Date(now - between(5, 50) * 1000) }
        : { isOnline: false, currentZoneId: null },
    });
  }

  // ── Ratings ─────────────────────────────────────────────────────────────
  const low = ["Drove too fast on the hill", "Waited 10 minutes at the gate", "Rude when I asked to stop at the junction", null];
  for (const r of completedRides) {
    if (random() > 0.6) continue;
    const stars = random() < 0.08 ? (random() < 0.5 ? 1 : 2) : random() < 0.3 ? 4 : 5;
    await prisma.rating.create({
      data: { rideId: r.id, raterId: r.riders[0]!, rateeId: r.driverUserId, stars, comment: stars <= 2 ? pick(low) : random() < 0.2 ? "Smooth ride, thanks" : null, createdAt: new Date(r.at + 2 * MIN) },
    });
  }

  // ── Location trail: a point a minute while on a shift ───────────────────
  const points: Array<{ driverUserId: string; latitude: number; longitude: number; recordedAt: Date; onTrip: boolean }> = [];
  for (const s of pastShifts) {
    let at = pick(places);
    let lat = at.latitude;
    let lng = at.longitude;
    for (let t = s.startedAt; t < Math.min(s.endedAt, now); t += MIN) {
      if (random() < 0.05) at = pick(places);
      lat += (at.latitude - lat) * 0.15 + (random() - 0.5) * 0.0003;
      lng += (at.longitude - lng) * 0.15 + (random() - 0.5) * 0.0003;
      points.push({ driverUserId: s.driverUserId, latitude: lat, longitude: lng, recordedAt: new Date(t), onTrip: random() < 0.35 });
    }
  }
  for (let i = 0; i < points.length; i += 5000) await prisma.driverLocationPoint.createMany({ data: points.slice(i, i + 5000) });

  // ── Cash handed over ────────────────────────────────────────────────────
  const owed = await prisma.commissionLedger.groupBy({ by: ["driverUserId"], where: { driverUserId: { in: drivers.map((d) => d.userId) } }, _sum: { amountPesewas: true } });
  let payments = 0;
  for (const [i, o] of owed.entries()) {
    const total = o._sum.amountPesewas ?? 0;
    if (i % 4 === 3) continue; // some never paid
    const share = i % 4 === 0 ? 1 : i % 4 === 1 ? 0.6 : 0.3;
    const amount = Math.round((total * share) / 100) * 100;
    if (amount <= 0) continue;
    const p = await prisma.driverCashPayment.create({
      data: { driverUserId: o.driverUserId, amountPesewas: amount, method: i % 2 ? "MOMO" : "CASH", note: i % 2 ? "MoMo ref 48213" : null, paidAt: new Date(now - between(1, 6) * DAY), recordedBy: admin.id },
    });
    payments += 1;
    if (i === 1) {
      // A mistake, put right with a reversal.
      const wrong = await prisma.driverCashPayment.create({ data: { driverUserId: o.driverUserId, amountPesewas: 500, method: "CASH", paidAt: new Date(now - 3 * DAY), recordedBy: admin.id, note: "Typed twice" } });
      await prisma.driverCashPayment.create({ data: { driverUserId: o.driverUserId, amountPesewas: -500, method: "CASH", paidAt: new Date(now - 3 * DAY + HOUR), recordedBy: admin.id, reversesId: wrong.id, reversalReason: "Recorded twice by mistake" } });
    }
    void p;
  }

  // ── SOS: one handled last week, one open from today ─────────────────────
  const sosRides = completedRides.slice(-12);
  if (sosRides.length >= 2) {
    const handled = sosRides[0]!;
    await prisma.sosEvent.create({
      data: {
        rideId: handled.id,
        riderId: handled.riders[0]!,
        rideStatus: "IN_PROGRESS",
        createdAt: new Date(handled.at - 6 * MIN),
        latitude: places[0]!.latitude,
        longitude: places[0]!.longitude,
        hasContact: true,
        smsDelivered: true,
        supportNotified: true,
        handledAt: new Date(handled.at + 20 * MIN),
        handledBy: admin.id,
        handledNote: "Called the rider; the driver had missed a turn. She arrived safely.",
      },
    });
    const open = sosRides[sosRides.length - 1]!;
    await prisma.sosEvent.create({
      data: { rideId: open.id, riderId: open.riders[0]!, rideStatus: "IN_PROGRESS", createdAt: new Date(open.at - 5 * MIN), hasContact: false, smsDelivered: false, supportNotified: true },
    });
  }

  console.log(
    `Seeded ${riders.length} riders, ${drivers.length + 1} drivers (one waiting for approval, one suspended), ${pastShifts.length} online sessions, ${made} requests (${completed} completed), ${points.length} trail points, ${payments} payments and 2 SOS alerts, over the last ${DAYS} days.`,
  );
  console.log(`Sign in to the admin site as "Seed Admin" (${admin.phone}); in development the code is in the server log.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
