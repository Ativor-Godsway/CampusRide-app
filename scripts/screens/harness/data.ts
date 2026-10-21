/**
 * Made-up data for the screenshots: real campus places (their coordinates
 * from apps/server/prisma/data/campus-places.csv), invented people.
 */
import {
  TERMS_VERSION,
  encodePolyline,
  type CampusPlace,
  type PlaceCategory,
  type Zone,
} from "@rida/shared";
import type { AuthUser, EligibleRideItem, RideSummary, RideWithZones } from "@rida/mobile-shared";

const PLACES: [string, PlaceCategory, number, number][] = [
  ["Main Gate", "GATE", 5.65017, -0.17896],
  ["Balme Library", "LANDMARK", 5.652012, -0.187048],
  ["Night Market", "FOOD", 5.642503, -0.186282],
  ["Legon Hall", "HALL", 5.649374, -0.187998],
  ["Akuafo Hall", "HALL", 5.649357, -0.186087],
  ["Maison Française", "FACULTY", 5.649319, -0.187542],
  ["Commonwealth Hall", "HALL", 5.650804, -0.192672],
  ["Volta Hall", "HALL", 5.651496, -0.189693],
  ["Bush Canteen", "FOOD", 5.645597, -0.18006],
];

const id = (name: string) => name.toLowerCase().replace(/[^a-z]+/g, "-");

/** One zone per place, at the place: every pin is well inside the service area. */
export const zones: Zone[] = PLACES.map(([name, , latitude, longitude]) => ({
  id: `zone-${id(name)}`,
  name,
  quadrant: "CENTRAL",
  latitude,
  longitude,
}));

export const places: CampusPlace[] = PLACES.map(([name, category, latitude, longitude]) => ({
  id: `place-${id(name)}`,
  name,
  aliases: [],
  latitude,
  longitude,
  category,
  zoneId: `zone-${id(name)}`,
}));

export const place = (name: string) => places.find((p) => p.name === name)!;
export const zone = (name: string) => zones.find((z) => z.name === name)!;

const TERMS = {
  ageConfirmedAt: "2026-09-01T09:00:00.000Z",
  termsAcceptedAt: "2026-09-01T09:00:00.000Z",
  termsVersion: TERMS_VERSION,
};

export const rider: AuthUser = {
  id: "rider-ama",
  phone: "+233548608146",
  name: "Ama Owusu",
  role: "RIDER",
  emergencyContactName: "Esi Owusu",
  emergencyContactPhone: "+233241112233",
  driver: null,
  ...TERMS,
};

export const driver = (isOnline: boolean): AuthUser => ({
  id: "driver-kofi",
  phone: "+233201234567",
  name: "Kofi Boateng",
  role: "DRIVER",
  driver: {
    id: "driver-1",
    carMake: "Toyota",
    carModel: "Corolla",
    carColor: "Silver",
    plate: "GR 1234-24",
    photoUrl: null,
    isApproved: true,
    isOnline,
  },
  ...TERMS,
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

function pins(from: string, to: string, note: string | null = null) {
  const a = place(from);
  const b = place(to);
  return {
    pickupLat: a.latitude,
    pickupLng: a.longitude,
    pickupLabel: a.name,
    pickupPlaceId: a.id,
    dropoffLat: b.latitude,
    dropoffLng: b.longitude,
    dropoffLabel: b.name,
    dropoffPlaceId: b.id,
    pickupNote: note,
  };
}

function ride(
  rideId: string,
  from: string,
  to: string,
  extra: Partial<RideSummary> = {},
): RideSummary {
  return {
    id: rideId,
    riderId: rider.id,
    driverId: "driver-1",
    type: "SHARED",
    status: "COMPLETED",
    source: "APP",
    pickupZoneId: zone(from).id,
    dropoffZoneId: zone(to).id,
    pickupZone: zone(from),
    dropoffZone: zone(to),
    occupancy: 1,
    fareTotal: 500,
    driverShare: 425,
    paymentStatus: "COLLECTED",
    paymentMethod: "CASH",
    cancelReason: null,
    mergedIntoRideId: null,
    createdAt: daysAgo(1),
    departedAt: daysAgo(1),
    completedAt: daysAgo(1),
    broadcastStartedAt: daysAgo(1),
    decisionStartedAt: null,
    ...pins(from, to),
    ...extra,
  };
}

/** The rider's recent trips (Home's recent places). */
export const riderRides: RideSummary[] = [
  ride("ride-1", "Akuafo Hall", "Balme Library"),
  ride("ride-2", "Balme Library", "Night Market", { createdAt: daysAgo(2) }),
  ride("ride-3", "Night Market", "Main Gate", {
    createdAt: daysAgo(4),
    type: "LONE",
    fareTotal: 1500,
  }),
];

/** A road route between two points (a straight-ish line: the map is a grey box anyway). */
export function roadRoute(points: { latitude: number; longitude: number }[]) {
  return {
    polyline: encodePolyline(points),
    distanceMeters: 1600,
    durationSeconds: 240,
    legs: points.slice(1).map(() => ({ distanceMeters: 1600, durationSeconds: 240 })),
    source: "osrm" as const,
  };
}

/** A Ride-alone request near the driver: the offer pop-up. */
export const offer: EligibleRideItem = {
  rideId: "ride-offer",
  riderFirstName: "Kwame",
  pickupZoneName: "Maison Française",
  pickupZoneId: zone("Maison Française").id,
  dropoffZoneName: "Night Market",
  dropoffZoneId: zone("Night Market").id,
  pickupPlaceName: "Maison Française",
  dropoffPlaceName: "Night Market",
  type: "LONE",
  seats: 1,
  farePesewas: 1500,
  driverSharePesewas: 1275,
  createdAt: minutesAgo(0.1),
  bestFit: true,
  riderRating: 4.9,
  pickupDistanceMeters: 400,
  pickupMinutes: 2,
  tripDistanceMeters: 1600,
  tripMinutes: 6,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  offerSeconds: 15,
};

/** The driver's trip: heading to pick Kwame up at Maison Française. */
export const driverTrip: RideWithZones = {
  id: "ride-trip",
  riderId: "rider-kwame",
  driverId: "driver-1",
  type: "LONE",
  status: "MATCHED",
  source: "APP",
  pickupZoneId: zone("Maison Française").id,
  dropoffZoneId: zone("Night Market").id,
  pickupZone: zone("Maison Française"),
  dropoffZone: zone("Night Market"),
  occupancy: 1,
  fareTotal: 1500,
  driverShare: 1275,
  paymentStatus: "PENDING",
  paymentMethod: "CASH",
  cancelReason: null,
  mergedIntoRideId: null,
  createdAt: new Date(Date.now() - 3 * 60_000),
  departedAt: null,
  completedAt: null,
  broadcastStartedAt: new Date(Date.now() - 3 * 60_000),
  decisionStartedAt: null,
  riderName: "Kwame Mensah",
  riderPhone: "+233241234567",
  ...pins("Maison Française", "Night Market", "Waiting at the bus stop"),
  passengers: [
    {
      id: "passenger-kwame",
      riderId: "rider-kwame",
      riderName: "Kwame Mensah",
      riderPhone: "+233241234567",
      pickupZoneName: "Maison Française",
      dropoffZoneName: "Night Market",
      pickupZoneId: zone("Maison Française").id,
      dropoffZoneId: zone("Night Market").id,
      lockedFare: 1500,
      status: "WAITING",
      arrivedAt: null,
      ...pins("Maison Française", "Night Market", "Waiting at the bus stop"),
    },
  ],
};

/** The rider's request, still looking for a driver (Choose a ride's searching state). */
export const riderSearching = (() => {
  const base = ride("ride-search", "Akuafo Hall", "Balme Library", {
    status: "REQUESTED",
    driverId: null,
    fareTotal: null,
    driverShare: null,
    paymentStatus: "PENDING",
    createdAt: new Date(Date.now() - 40_000),
    broadcastStartedAt: new Date(Date.now() - 40_000),
    departedAt: null,
    completedAt: null,
  });
  return {
    ride: {
      ...base,
      passengers: [
        {
          id: "passenger-ama",
          rideId: base.id,
          riderId: rider.id,
          pickupZoneId: base.pickupZoneId,
          dropoffZoneId: base.dropoffZoneId,
          fareCharged: null,
          lockedFare: 500,
          status: "WAITING" as const,
          ...pins("Akuafo Hall", "Balme Library"),
        },
      ],
    },
    driver: null,
  };
})();

/** GET /rides/active while Kwame is on his way to Ama (Home's ride row). */
export const riderActiveRide = {
  id: "ride-active",
  status: "MATCHED" as const,
  type: "SHARED" as const,
  legStatus: "WAITING" as const,
  pickupZone: {
    id: zone("Akuafo Hall").id,
    name: "Akuafo Hall",
    latitude: place("Akuafo Hall").latitude,
    longitude: place("Akuafo Hall").longitude,
  },
  dropoffZone: {
    id: zone("Balme Library").id,
    name: "Balme Library",
    latitude: place("Balme Library").latitude,
    longitude: place("Balme Library").longitude,
  },
  driver: { firstName: "Kwame" },
  ...pins("Akuafo Hall", "Balme Library"),
};

/** Ama's driver, as GET /rides/:id sends him. */
export const riderDriver = {
  driverId: "driver-1",
  name: "Kwame Mensah",
  phone: "+233241234567",
  carMake: "Toyota",
  carModel: "Corolla",
  carColor: "Silver",
  plate: "GR 1234-24",
  rating: 4.9,
  photoUrl: null,
};

/**
 * Ama's shared ride with Kwame, from Akuafo Hall to Balme Library: Kwame on
 * his way, at the pickup, or with Ama on board and Yaw (Legon Hall → Main
 * Gate) still to collect first. Yaw's pins are hidden, as the server does
 * for another rider.
 */
export function riderTrip(stage: "coming" | "arrived" | "onboard") {
  const base = ride("ride-live", "Akuafo Hall", "Balme Library", {
    status: stage === "onboard" ? "IN_PROGRESS" : "MATCHED",
    occupancy: stage === "onboard" ? 2 : 1,
    paymentStatus: "PENDING",
    createdAt: new Date(Date.now() - 6 * 60_000),
    broadcastStartedAt: new Date(Date.now() - 6 * 60_000),
    departedAt: stage === "onboard" ? new Date(Date.now() - 60_000) : null,
    completedAt: null,
  });
  const ama = {
    id: "passenger-ama",
    rideId: base.id,
    riderId: rider.id,
    pickupZoneId: base.pickupZoneId,
    dropoffZoneId: base.dropoffZoneId,
    fareCharged: null,
    lockedFare: 500,
    status: stage === "coming" ? "WAITING" : stage === "arrived" ? "ARRIVED" : "PICKED_UP",
    ...pins("Akuafo Hall", "Balme Library"),
  };
  const yaw = {
    id: "passenger-yaw",
    rideId: base.id,
    riderId: "rider-yaw",
    pickupZoneId: zone("Legon Hall").id,
    dropoffZoneId: zone("Main Gate").id,
    fareCharged: null,
    lockedFare: 500,
    status: "WAITING",
  };
  return {
    ride: { ...base, passengers: stage === "onboard" ? [ama, yaw] : [ama] },
    driver: riderDriver,
  };
}

/** Where Kwame is: coming up from Bush Canteen's way, or just past Akuafo Hall with Ama. */
export function riderTripDriverAt(stage: "coming" | "arrived" | "onboard") {
  const at =
    stage === "coming"
      ? { lat: 5.6468, lng: -0.1832 }
      : stage === "arrived"
        ? { lat: place("Akuafo Hall").latitude, lng: place("Akuafo Hall").longitude }
        : { lat: 5.65, lng: -0.1865 };
  return { "ride:driver_location": { rideId: "ride-live", ...at, ts: Date.now() } };
}

/** Ama's shared ride, finished: Kwame dropped her at Balme Library a moment ago. */
export function riderTripCompleted() {
  const live = riderTrip("onboard");
  return {
    ride: {
      ...live.ride,
      status: "COMPLETED",
      completedAt: new Date(),
      passengers: live.ride.passengers.map((p) => ({ ...p, status: "DROPPED_OFF" })),
    },
    driver: riderDriver,
    fareSummary: {
      yourFarePesewas: 500,
      totalFarePesewas: 1000,
      paymentMethod: "CASH",
      paymentStatus: "PENDING",
    },
  };
}

/** Ama's request, cancelled because no driver was free. */
export const riderTripCancelled = {
  ...riderSearching,
  ride: { ...riderSearching.ride, status: "CANCELLED", cancelReason: "NO_DRIVERS_AVAILABLE" },
};

/** A time `days` ago at hh:mm, for the history's day groups. */
function at(days: number, hours: number, minutes: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** The Rides tab: today, yesterday and earlier, with one cancelled trip. */
export const riderHistory: RideSummary[] = [
  ride("ride-h1", "Night Market", "Balme Library", { createdAt: at(0, 0, 5) }),
  ride("ride-h2", "Akuafo Hall", "Main Gate", {
    createdAt: at(1, 18, 36),
    status: "CANCELLED",
    cancelReason: "RIDER_CANCELLED",
    fareTotal: null,
  }),
  ride("ride-h3", "Volta Hall", "Night Market", {
    createdAt: at(1, 8, 12),
    type: "LONE",
    fareTotal: 1500,
  }),
  ride("ride-h4", "Balme Library", "Commonwealth Hall", { createdAt: at(3, 19, 2) }),
  ride("ride-h5", "Bush Canteen", "Legon Hall", { createdAt: at(4, 13, 40) }),
];

/** A completed trip on the driver's Earnings, `hoursAgo` from now. */
function earning(
  rideId: string,
  from: string,
  to: string,
  hoursAgo: number,
  type: "SHARED" | "LONE",
) {
  const face = type === "LONE" ? 1500 : 500;
  return {
    rideId,
    pickupZoneName: from,
    dropoffZoneName: to,
    pickupPlaceName: from,
    dropoffPlaceName: to,
    type,
    source: "APP" as const,
    completedAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    facePesewas: face,
    driverGrossPesewas: Math.round(face * 0.85),
  };
}

/**
 * GET /driver/rides/history. `today`: two trips completed in the last half
 * hour (GH₵4.25 + GH₵12.75 = GH₵17.00), so they're today at any clock time.
 */
export function driverHistory(today: boolean) {
  const rides = [
    ...(today
      ? [
          earning("ride-e1", "Night Market", "Balme Library", 0.1, "SHARED"),
          earning("ride-e2", "Main Gate", "Volta Hall", 0.4, "LONE"),
        ]
      : []),
    earning("ride-e3", "Akuafo Hall", "Night Market", 30, "SHARED"),
    earning("ride-e4", "Legon Hall", "Bush Canteen", 54, "LONE"),
  ];
  const gross = rides.reduce((sum, r) => sum + r.driverGrossPesewas, 0);
  const commission = rides.reduce((sum, r) => sum + Math.round(r.facePesewas * 0.15), 0);
  return {
    rides,
    summary: {
      totalRides: rides.length,
      totalGrossPesewas: gross,
      commissionOwedPesewas: commission,
      netPesewas: gross - commission,
      commissionRidesCount: rides.length,
    },
  };
}

/** Requests near the driver: a shared and a private one. */
export const driverRequests: EligibleRideItem[] = [
  offer,
  {
    ...offer,
    rideId: "ride-offer-2",
    riderFirstName: "Akosua",
    pickupZoneName: "Volta Hall",
    pickupZoneId: zone("Volta Hall").id,
    pickupPlaceName: "Volta Hall",
    dropoffZoneName: "Balme Library",
    dropoffZoneId: zone("Balme Library").id,
    dropoffPlaceName: "Balme Library",
    type: "SHARED",
    farePesewas: 500,
    driverSharePesewas: 425,
    createdAt: minutesAgo(2),
    bestFit: false,
    pickupDistanceMeters: 650,
    pickupMinutes: 3,
  },
];

/** A shared trip still filling up: one rider so far. */
export const driverSharedTrip: RideWithZones = {
  ...driverTrip,
  id: "ride-shared",
  type: "SHARED",
  fareTotal: 500,
  driverShare: 425,
  passengers: driverTrip.passengers.map((p) => ({ ...p, lockedFare: 500 })),
};
