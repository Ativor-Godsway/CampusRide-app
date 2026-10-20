/** The driver app's scenes. Each chain is the real route files, root layout first. */
import RootLayout from "../../../apps/driver/app/_layout";
import AuthLayout from "../../../apps/driver/app/auth/_layout";
import WelcomeRoute from "../../../apps/driver/app/auth/welcome";
import SignupRoute from "../../../apps/driver/app/auth/signup";
import TabsLayout from "../../../apps/driver/app/(tabs)/_layout";
import DriverHome from "../../../apps/driver/app/(tabs)/index";
import TripScreen from "../../../apps/driver/app/ride/[id]";
import DesignGallery from "../../../apps/driver/app/dev/design-gallery";
import { boot, type Routes, type Scene } from "./core";
import { driver, driverTrip, offer, place, roadRoute, zones } from "./data";

/** What every signed-in driver screen asks for. */
const signedIn = (extra: Routes = {}): Routes => ({
  "GET /zones": { zones },
  "GET /zones/routes": { routes: [] },
  "GET /driver/rides/active": { ride: null },
  "GET /driver/rides/eligible": { rides: [] },
  "PATCH /driver/zone": { ok: true },
  "PATCH /driver/availability": { ok: true },
  "PUT /me/push-token": { ok: true },
  "POST /routes/legs": (body) =>
    roadRoute((body as { points: { latitude: number; longitude: number }[] }).points),
  ...extra,
});

// Parked near Akuafo Hall.
const here = place("Akuafo Hall");

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
  {
    name: "home-offline",
    user: driver(false),
    routes: signedIn(),
    chain: [RootLayout, TabsLayout, DriverHome],
    pathname: "/",
    position: here,
  },
  {
    name: "home-online",
    user: driver(true),
    routes: signedIn(),
    chain: [RootLayout, TabsLayout, DriverHome],
    pathname: "/",
    position: here,
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
