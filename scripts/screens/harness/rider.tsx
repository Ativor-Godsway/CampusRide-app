/** The rider app's scenes. Each chain is the real route files, root layout first. */
import { gpsEnd, tripEndParams } from "@rida/shared";
import RootLayout from "../../../apps/rider/app/_layout";
import AuthLayout from "../../../apps/rider/app/auth/_layout";
import PhoneRoute from "../../../apps/rider/app/auth/phone";
import OtpRoute from "../../../apps/rider/app/auth/otp";
import TabsLayout from "../../../apps/rider/app/(tabs)/_layout";
import HomeTab from "../../../apps/rider/app/(tabs)/index";
import PlanYourRide from "../../../apps/rider/app/ride/location";
import ChooseRide from "../../../apps/rider/app/ride/type";
import DesignGallery from "../../../apps/rider/app/dev/design-gallery";
import { boot, type Routes, type Scene } from "./core";
import { place, places, rider, riderRides, roadRoute, zones } from "./data";

/** What every signed-in rider screen asks for. */
const signedIn: Routes = {
  "GET /zones": { zones },
  "GET /places": { places },
  "GET /rides/active": { ride: null },
  "GET /rides/mine": { rides: riderRides, nextCursor: null, hasMore: false },
  "PUT /me/push-token": { ok: true },
  "POST /routes/legs": (body) =>
    roadRoute((body as { points: { latitude: number; longitude: number }[] }).points),
};

// Standing at Akuafo Hall, going to Balme Library.
const here = place("Akuafo Hall");
const pickup = gpsEnd({ latitude: here.latitude, longitude: here.longitude }, places);
const dropoff = place("Balme Library");

const scenes: Scene[] = [
  {
    name: "design-gallery",
    full: true,
    dev: true,
    user: rider,
    routes: signedIn,
    chain: [RootLayout, DesignGallery],
    pathname: "/dev/design-gallery",
  },
  {
    name: "phone",
    user: null,
    chain: [RootLayout, AuthLayout, PhoneRoute],
    pathname: "/auth/phone",
  },
  {
    name: "otp",
    user: null,
    routes: { "POST /auth/request-otp": { ok: true } },
    chain: [RootLayout, AuthLayout, OtpRoute],
    pathname: "/auth/otp",
    params: { phone: rider.phone, purpose: "LOGIN" },
  },
  {
    name: "home",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
    position: here,
  },
  {
    name: "plan-your-ride",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, PlanYourRide],
    pathname: "/ride/location",
    position: here,
  },
  {
    name: "choose-a-ride",
    note: "map: grey box; sheet drawn still, without dragging",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, ChooseRide],
    pathname: "/ride/type",
    params: {
      ...tripEndParams("pickup", { ...pickup, label: pickup.label }),
      ...tripEndParams("dropoff", {
        kind: "place",
        latitude: dropoff.latitude,
        longitude: dropoff.longitude,
        label: dropoff.name,
        placeId: dropoff.id,
      }),
      from: "plan",
    },
    position: here,
  },
];

boot(scenes);
