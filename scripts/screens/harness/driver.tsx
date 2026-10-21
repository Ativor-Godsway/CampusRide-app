/** The driver app's scenes. Each chain is the real route files, root layout first. */
import RootLayout from "../../../apps/driver/app/_layout";
import AuthLayout from "../../../apps/driver/app/auth/_layout";
import WelcomeRoute from "../../../apps/driver/app/auth/welcome";
import SignupRoute from "../../../apps/driver/app/auth/signup";
import TabsLayout from "../../../apps/driver/app/(tabs)/_layout";
import DriverHome from "../../../apps/driver/app/(tabs)/index";
import EarningsTab from "../../../apps/driver/app/(tabs)/rides";
import TripScreen from "../../../apps/driver/app/ride/[id]";
import DesignGallery from "../../../apps/driver/app/dev/design-gallery";
import { boot, refuse, type Routes, type Scene } from "./core";
import {
  driver,
  driverHistory,
  driverRequests,
  driverSharedTrip,
  driverSharedFilling,
  driverSharedOnTheWay,
  driverTrip,
  driverTripAt,
  fitPreview,
  fitSuggestion,
  newRiderOffer,
  place,
  roadRoute,
  sharedOfferQueue,
  zones,
} from "./data";

/** What every signed-in driver screen asks for. */
const signedIn = (extra: Routes = {}): Routes => ({
  "GET /zones": { zones },
  "GET /zones/routes": { routes: [] },
  "GET /driver/rides/active": { ride: null },
  "GET /driver/rides/eligible": { rides: [] },
  "GET /driver/rides/history": driverHistory(false),
  "PATCH /driver/zone": { ok: true },
  "PATCH /driver/availability": { ok: true },
  "PUT /me/push-token": { ok: true },
  "POST /routes/legs": (body) =>
    roadRoute((body as { points: { latitude: number; longitude: number }[] }).points),
  ...extra,
});

// Parked near Akuafo Hall.
const here = place("Akuafo Hall");

/** Home, with today's earnings. */
const home = (name: string, online: boolean, extra: Partial<Scene> = {}): Scene => ({
  name,
  note: "map: grey box (the car, and its pulse while online, are drawn on the map)",
  user: driver(online),
  routes: signedIn({ "GET /driver/rides/history": driverHistory(online) }),
  chain: [RootLayout, TabsLayout, DriverHome],
  pathname: "/",
  position: here,
  ...extra,
});

/**
 * Online with requests near the driver: the first opens full screen. `claim`
 * is POST /rides/<id>/claim's answer for that one; once tried, the request
 * leaves the list (as the server's would, for a request that's gone).
 */
const offerScene = (
  name: string,
  requests: typeof sharedOfferQueue,
  extra: Partial<Scene> & { claim?: () => unknown } = {},
): Scene => {
  let tried = false;
  const { claim, ...rest } = extra;
  return {
    name,
    note: "map: grey box (the car, a dashed line to the pickup and the route are drawn on the map)",
    user: driver(true),
    routes: signedIn({
      "GET /driver/rides/history": driverHistory(true),
      "GET /driver/rides/eligible": () => ({ rides: tried ? requests.slice(1) : requests }),
      ...(claim
        ? {
            [`POST /rides/${requests[0]!.rideId}/claim`]: () => {
              tried = true;
              return claim();
            },
          }
        : {}),
    }),
    chain: [RootLayout, TabsLayout, DriverHome],
    pathname: "/",
    position: here,
    ...rest,
  };
};
const ACCEPT_LONE = "Accept, 15 cedis";

/**
 * The trip screen on `ride`, with the driver at `position`. Every step the
 * driver can take on it is answered (and the passengers' new state isn't
 * fetched again, so the screen keeps what it showed).
 */
const tripScene = (
  name: string,
  ride: typeof driverTrip,
  position: { latitude: number; longitude: number },
  extra: Partial<Scene> & { routes?: Routes } = {},
): Scene => {
  const steps = ride.passengers.flatMap((p) =>
    ["arrived", "pickup", "dropoff", "cancel"].map((a) => [
      `POST /rides/${ride.id}/passengers/${p.id}/${a}`,
      { ok: true },
    ]),
  );
  const { routes, ...rest } = extra;
  return {
    name,
    note: "map: grey box (the route, numbered stops and the car are drawn on the map)",
    user: driver(true),
    routes: signedIn({
      "GET /driver/rides/active": { ride },
      [`GET /rides/${ride.id}/fill-suggestions`]: {
        suggestions: [],
        freeSeats: 4,
        occupancy: 1,
        passengers: [],
      },
      ...Object.fromEntries(steps),
      ...routes,
    }),
    chain: [RootLayout, TripScreen],
    pathname: `/ride/${ride.id}`,
    params: { id: ride.id },
    position,
    // Foreground tracking: the harness has no background location task to deliver fixes.
    locationBackground: "undetermined",
    ...rest,
  };
};
/** About 400 m from Maison Française. */
const onTheWay = { latitude: 5.6524, longitude: -0.1868 };
/** At Kwame's pickup pin. */
const atPickup = {
  latitude: place("Maison Française").latitude,
  longitude: place("Maison Française").longitude,
};
/** Between the pickup and Night Market. */
const midTrip = { latitude: 5.6462, longitude: -0.1868 };

const scenes: Scene[] = [
  {
    name: "design-gallery",
    full: true,
    dev: true,
    user: driver(false),
    routes: signedIn(),
    chain: [RootLayout, DesignGallery],
    pathname: "/dev/design-gallery",
  },
  {
    name: "welcome",
    user: null,
    chain: [RootLayout, AuthLayout, WelcomeRoute],
    pathname: "/auth/welcome",
  },
  {
    name: "name-step",
    user: null,
    chain: [RootLayout, AuthLayout, SignupRoute],
    pathname: "/auth/signup",
    params: { phone: "+233201234567", verifiedToken: "verified" },
  },
  home("home-offline", false),
  home("home-online", true),
  home("home-online-requests", true, {
    routes: signedIn({
      "GET /driver/rides/history": driverHistory(true),
      "GET /driver/rides/eligible": { rides: driverRequests },
      ...Object.fromEntries(
        driverRequests.map((r) => [`POST /rides/${r.rideId}/reject`, { ok: true }]),
      ),
    }),
    // Each request also opens full screen first: decline both to see the list.
    steps: [
      { press: "Decline this offer" },
      { wait: 600 },
      { press: "Decline this offer" },
      { wait: 600 },
    ],
  }),
  home("home-filling-car", true, {
    routes: signedIn({
      "GET /driver/rides/history": driverHistory(true),
      "GET /driver/rides/active": { ride: driverSharedTrip },
      [`GET /rides/${driverSharedTrip.id}/fill-suggestions`]: { suggestions: [], freeSeats: 3 },
    }),
  }),
  home("home-location-disclosure", false, {
    note: "Go online with 'all the time' not asked yet: the disclosure comes first",
    locationBackground: "undetermined",
    steps: [{ press: "Go online" }, { wait: 500 }],
  }),
  home("home-location-error", false, {
    note: "the 'Always' request fails (as a store build can): offline, with what to do",
    locationBackground: "fails",
    steps: [{ press: "Go online" }, { wait: 500 }, { press: "Continue" }, { wait: 800 }],
  }),
  {
    name: "earnings-tab",
    user: driver(true),
    routes: signedIn({ "GET /driver/rides/history": driverHistory(true) }),
    chain: [RootLayout, TabsLayout, EarningsTab],
    pathname: "/rides",
  },
  offerScene("offer-ride-alone-new-rider", [newRiderOffer]),
  offerScene("offer-shared-waiting", sharedOfferQueue),
  offerScene("offer-accepting", [newRiderOffer], {
    // The server hasn't answered yet.
    claim: () => new Promise(() => undefined),
    steps: [{ press: ACCEPT_LONE }, { wait: 300 }],
  }),
  offerScene("offer-error", [newRiderOffer], {
    claim: () => refuse(503, "Service unavailable"),
    steps: [{ press: ACCEPT_LONE }, { wait: 500 }],
  }),
  offerScene("offer-taken-toast", [newRiderOffer], {
    note: "Accept, but another driver got there first: the takeover closes with a toast",
    claim: () =>
      refuse(409, "Ride taken by another driver.", { code: "RIDE_NOT_AVAILABLE", reason: "TAKEN" }),
    steps: [{ press: ACCEPT_LONE }, { wait: 400 }],
  }),
  tripScene("trip-to-pickup", driverTripAt("coming"), onTheWay),
  tripScene("trip-near-pickup", driverTripAt("coming"), atPickup, {
    note: "within the arrival distance of Kwame's pin: I'm here, before automatic arrival",
  }),
  tripScene("trip-waiting", driverTripAt("waiting"), atPickup),
  tripScene("trip-dropoff-cash", driverTripAt("onboard"), midTrip),
  tripScene("trip-shared", driverSharedOnTheWay, midTrip),
  tripScene("trip-menu", driverTripAt("coming"), atPickup, {
    steps: [{ press: "More actions" }, { wait: 300 }],
  }),
  tripScene("trip-stops", driverSharedOnTheWay, midTrip, {
    steps: [{ press: "Show all stops" }, { wait: 300 }],
  }),
  tripScene("trip-add-rider", driverSharedFilling, onTheWay, {
    note: "a rider who fits, offered by itself with the detour the server worked out",
    routes: {
      [`GET /rides/${driverSharedFilling.id}/fill-suggestions`]: {
        suggestions: [fitSuggestion],
        occupancy: 1,
        passengers: [],
      },
      [`GET /rides/${driverSharedFilling.id}/add-preview`]: fitPreview(driverSharedFilling),
    },
    settleMs: 3500,
  }),
  tripScene("trip-in-car-toast", driverTripAt("coming"), atPickup, {
    note: "after the pickup slide (a long-press in the harness)",
    steps: [{ press: "Slide when Kwame is in" }, { wait: 400 }],
  }),
];

boot(scenes);
