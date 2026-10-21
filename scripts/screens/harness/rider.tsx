/** The rider app's scenes. Each chain is the real route files, root layout first. */
import { gpsEnd, tripEndParams } from "@rida/shared";
import RootLayout from "../../../apps/rider/app/_layout";
import AuthLayout from "../../../apps/rider/app/auth/_layout";
import WelcomeRoute from "../../../apps/rider/app/auth/welcome";
import PhoneRoute from "../../../apps/rider/app/auth/phone";
import OtpRoute from "../../../apps/rider/app/auth/otp";
import SignupRoute from "../../../apps/rider/app/auth/signup";
import TabsLayout from "../../../apps/rider/app/(tabs)/_layout";
import HomeTab from "../../../apps/rider/app/(tabs)/index";
import RidesTab from "../../../apps/rider/app/(tabs)/rides";
import AccountTab from "../../../apps/rider/app/(tabs)/account";
import SafetyRoute from "../../../apps/rider/app/safety";
import ProfileRoute from "../../../apps/rider/app/profile";
import NotificationsRoute from "../../../apps/rider/app/notifications";
import LicensesRoute from "../../../apps/rider/app/licenses";
import PlanYourRide from "../../../apps/rider/app/ride/location";
import ChooseRide from "../../../apps/rider/app/ride/type";
import PickOnMap from "../../../apps/rider/app/ride/pick";
import DeleteAccountRoute from "../../../apps/rider/app/delete-account";
import DesignGallery from "../../../apps/rider/app/dev/design-gallery";
import { boot, refuse, type Routes, type Scene } from "./core";
import {
  driver,
  place,
  places,
  rider,
  riderActiveRide,
  riderHistory,
  riderRides,
  riderSearching,
  riderTrip,
  riderTripCancelled,
  riderTripCompleted,
  riderTripDriverAt,
  roadRoute,
  zones,
} from "./data";

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
const routeParams = {
  ...tripEndParams("pickup", pickup),
  ...tripEndParams("dropoff", {
    kind: "place",
    latitude: dropoff.latitude,
    longitude: dropoff.longitude,
    label: dropoff.name,
    placeId: dropoff.id,
  }),
};
const CODE_FIELD = "Verification code, 6 digits";
const otp = (extra: Partial<Scene>): Scene => ({
  name: "otp",
  user: null,
  routes: { "POST /auth/request-otp": { ok: true } },
  chain: [RootLayout, AuthLayout, OtpRoute],
  pathname: "/auth/otp",
  params: { phone: rider.phone },
  ...extra,
});
/** Choose a ride reopened on Ama's request, still searching (`openCancel`: on its cancel steps). */
const searching = (extra: Partial<Scene>, openCancel = false): Scene => ({
  name: "searching",
  note: "map: grey box (the pickup's pulse rings are drawn on the map)",
  user: rider,
  routes: { ...signedIn, [`GET /rides/${riderSearching.ride.id}`]: riderSearching },
  chain: [RootLayout, ChooseRide],
  pathname: "/ride/type",
  params: {
    ...routeParams,
    rideId: riderSearching.ride.id,
    ...(openCancel ? { openCancel: "1" } : {}),
  },
  position: here,
  ...extra,
});
/** Ama's ride with Kwame (riderTrip), with one GPS fix from him so there's an ETA. */
const trip = (stage: "coming" | "arrived" | "onboard", extra: Partial<Scene>): Scene => {
  const live = riderTrip(stage);
  return {
    name: `trip-${stage}`,
    note: "map: grey box (the car glides on the map)",
    user: rider,
    routes: { ...signedIn, [`GET /rides/${live.ride.id}`]: live },
    chain: [RootLayout, ChooseRide],
    pathname: "/ride/type",
    params: { ...routeParams, rideId: live.ride.id },
    position: here,
    socket: riderTripDriverAt(stage),
    ...extra,
  };
};

/** The trip is over: Choose a ride reopened on it, under its end-of-trip sheet. */
const ended = (
  name: string,
  answer: { ride: { id: string } },
  extra: Partial<Scene> = {},
): Scene => ({
  name,
  note: "map: grey box",
  user: rider,
  routes: {
    ...signedIn,
    [`GET /rides/${answer.ride.id}`]: answer,
    "POST /ratings": { rating: {} },
  },
  chain: [RootLayout, ChooseRide],
  pathname: "/ride/type",
  params: { ...routeParams, rideId: answer.ride.id },
  position: here,
  ...extra,
});

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
    name: "welcome",
    user: null,
    chain: [RootLayout, AuthLayout, WelcomeRoute],
    pathname: "/auth/welcome",
  },
  {
    name: "phone",
    user: null,
    chain: [RootLayout, AuthLayout, PhoneRoute],
    pathname: "/auth/phone",
  },
  {
    name: "phone-typed",
    user: null,
    chain: [RootLayout, AuthLayout, PhoneRoute],
    pathname: "/auth/phone",
    steps: [{ type: "Phone number", text: "548608146" }],
  },
  otp({ name: "otp" }),
  otp({ name: "otp-typing", steps: [{ type: CODE_FIELD, text: "4166" }] }),
  otp({
    name: "otp-error",
    routes: {
      "POST /auth/request-otp": { ok: true },
      "POST /auth/verify-code": refuse(400, `Invalid or missing OTP for ${rider.phone}`),
    },
    steps: [{ type: CODE_FIELD, text: "416641" }],
  }),
  {
    name: "name-step",
    user: null,
    chain: [RootLayout, AuthLayout, SignupRoute],
    pathname: "/auth/signup",
    params: { phone: rider.phone, verifiedToken: "verified" },
  },
  {
    name: "terms-confirmation",
    note: "an account from before sign-up asked: over every screen until confirmed",
    user: { ...rider, ageConfirmedAt: null, termsAcceptedAt: null, termsVersion: null },
    routes: signedIn,
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
    position: here,
  },
  {
    name: "role-mismatch",
    note: "a driver's number signed in to the rider app",
    user: driver(false),
    routes: signedIn,
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
  },
  {
    name: "home",
    note: "map: grey box",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
    position: here,
  },
  {
    name: "home-no-recents",
    note: "map: grey box; a first-time rider sees popular places",
    user: rider,
    routes: { ...signedIn, "GET /rides/mine": { rides: [], nextCursor: null, hasMore: false } },
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
    position: here,
  },
  {
    name: "home-location-off",
    note: "map: grey box (centred on campus)",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, TabsLayout, HomeTab],
    pathname: "/",
    locationOff: true,
  },
  {
    name: "home-active-ride",
    note: "map: grey box; no live ETA on the web (it comes from the driver's pings)",
    user: rider,
    routes: { ...signedIn, "GET /rides/active": { ride: riderActiveRide } },
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
    name: "plan-your-ride-results",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, PlanYourRide],
    pathname: "/ride/location",
    position: here,
    steps: [{ type: "Drop-off", text: "bal" }],
  },
  {
    name: "plan-your-ride-no-results",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, PlanYourRide],
    pathname: "/ride/location",
    position: here,
    steps: [{ type: "Drop-off", text: "xyz" }],
  },
  {
    name: "plan-your-ride-outside",
    note: "standing at Accra Mall, outside the campus area",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, PlanYourRide],
    pathname: "/ride/location",
    position: { latitude: 5.6219, longitude: -0.1736 },
  },
  {
    name: "choose-a-ride",
    note: "map: grey box; sheet drawn still, without dragging",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, ChooseRide],
    pathname: "/ride/type",
    params: { ...routeParams, from: "plan" },
    position: here,
  },
  {
    name: "choose-a-ride-alone",
    note: "map: grey box",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, ChooseRide],
    pathname: "/ride/type",
    params: { ...routeParams, from: "plan" },
    position: here,
    steps: [{ press: "Ride alone" }],
  },
  {
    name: "choose-a-ride-note",
    note: "map: grey box; no keyboard on the web",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, ChooseRide],
    pathname: "/ride/type",
    params: { ...routeParams, from: "plan" },
    position: here,
    steps: [
      { press: "Add a note for your driver" },
      { type: "Note for driver", text: "At the main gate, blue shirt" },
    ],
  },
  searching({ name: "searching" }),
  searching({ name: "cancel-confirm" }, true),
  searching(
    { name: "cancel-reason", steps: [{ press: "Cancel ride" }, { press: "Changed plans" }] },
    true,
  ),
  searching({
    name: "no-drivers",
    routes: {
      ...signedIn,
      [`GET /rides/${riderSearching.ride.id}`]: {
        ...riderSearching,
        ride: {
          ...riderSearching.ride,
          status: "AWAITING_RIDER_DECISION",
          decisionStartedAt: new Date(),
        },
      },
    },
  }),
  trip("coming", { name: "driver-on-the-way" }),
  trip("arrived", { name: "driver-arrived" }),
  trip("onboard", { name: "in-ride-shared" }),
  trip("coming", {
    name: "safety-sheet",
    steps: [{ press: "Safety: share your trip or call emergency services" }],
  }),
  trip("coming", {
    name: "safety-sheet-no-contact",
    user: { ...rider, emergencyContactName: null, emergencyContactPhone: null },
    steps: [{ press: "Safety: share your trip or call emergency services" }],
  }),
  ended("trip-complete", riderTripCompleted()),
  ended("trip-complete-4-stars", riderTripCompleted(), { steps: [{ press: "4 stars" }] }),
  ended("trip-complete-2-stars", riderTripCompleted(), { steps: [{ press: "2 stars" }] }),
  ended("trip-cancelled", riderTripCancelled),
  {
    name: "rides",
    user: rider,
    routes: {
      ...signedIn,
      "GET /rides/mine": { rides: riderHistory, nextCursor: null, hasMore: false },
    },
    chain: [RootLayout, TabsLayout, RidesTab],
    pathname: "/rides",
  },
  {
    name: "rides-empty",
    user: rider,
    routes: { ...signedIn, "GET /rides/mine": { rides: [], nextCursor: null, hasMore: false } },
    chain: [RootLayout, TabsLayout, RidesTab],
    pathname: "/rides",
  },
  {
    name: "account",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, TabsLayout, AccountTab],
    pathname: "/account",
  },
  {
    name: "safety-screen",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, SafetyRoute],
    pathname: "/safety",
  },
  {
    name: "safety-screen-no-contact",
    user: { ...rider, emergencyContactName: null, emergencyContactPhone: null },
    routes: signedIn,
    chain: [RootLayout, SafetyRoute],
    pathname: "/safety",
  },
  {
    name: "profile-edit",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, ProfileRoute],
    pathname: "/profile",
  },
  {
    name: "pick-on-map",
    note: "map: grey box",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, PickOnMap],
    pathname: "/ride/pick",
    params: { ...routeParams, field: "dropoff" },
    position: here,
  },
  {
    name: "delete-account",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, DeleteAccountRoute],
    pathname: "/delete-account",
  },
  {
    name: "licenses",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, LicensesRoute],
    pathname: "/licenses",
  },
  {
    name: "notifications",
    note: "as on a phone that hasn't been asked yet",
    user: rider,
    routes: signedIn,
    chain: [RootLayout, NotificationsRoute],
    pathname: "/notifications",
    pushUndetermined: true,
  },
];

boot(scenes);
