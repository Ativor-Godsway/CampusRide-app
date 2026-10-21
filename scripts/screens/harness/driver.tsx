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
import { boot, type Routes, type Scene } from "./core";
import {
  driver,
  driverHistory,
  driverRequests,
  driverSharedTrip,
  driverTrip,
  offer,
  place,
  roadRoute,
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
  {
    name: "ride-offer",
    user: driver(true),
    routes: signedIn({ "GET /driver/rides/eligible": { rides: [offer] } }),
    chain: [RootLayout, TabsLayout, DriverHome],
    pathname: "/",
    position: here,
  },
  {
    name: "trip",
    note: "map: grey box",
    user: driver(true),
    routes: signedIn({
      "GET /driver/rides/active": { ride: driverTrip },
      [`GET /rides/${driverTrip.id}/fill-suggestions`]: { suggestions: [], freeSeats: 3 },
    }),
    chain: [RootLayout, TripScreen],
    pathname: `/ride/${driverTrip.id}`,
    params: { id: driverTrip.id },
    position: here,
  },
];

boot(scenes);
